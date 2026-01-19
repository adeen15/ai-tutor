require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const crypto = require('crypto'); // Needed to verify the secret password
const { createClient } = require('@supabase/supabase-js'); // Needed to talk to DB

// --- DEBUG CHECK ---
console.log("-----------------------------------");
console.log("🔍 Server Starting...");
if (process.env.LEMONSQUEEZY_WEBHOOK_SECRET) console.log("✅ WEBHOOK SECRET: Loaded");
else console.log("❌ WEBHOOK SECRET: MISSING (Needed for auto-unlock)");
console.log("-----------------------------------");

const app = express();
app.use(cors());

// MAGIC TRICK: We need the "raw" code to verify the password, but JSON to read it.
// This line does both.
app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));

app.use(express.static(__dirname));

// Initialize Supabase (So the server can unlock premium for users)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// 1. HTML File
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '2nd gemini app.html'));
});

// 2. Frontend Config
app.get('/api/config', (req, res) => {
    res.json({
        supabaseUrl: process.env.SUPABASE_URL,
        supabaseKey: process.env.SUPABASE_ANON_KEY
    });
});

// 3. Chat AI
app.post('/api/chat', async (req, res) => {
    try {
        const { messages } = req.body;
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                "model": "google/gemini-2.0-flash-001",
                "messages": messages,
                "max_tokens": 120,
                "temperature": 0.6
            })
        });
        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error("Server Error:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// 4. Create Checkout (Sending user to Lemon Squeezy)
app.post('/api/create-checkout', async (req, res) => {
    try {
        const { userEmail } = req.body;
        console.log("Creating checkout for:", userEmail); 

        const response = await fetch('https://api.lemonsqueezy.com/v1/checkouts', {
            method: 'POST',
            headers: {
                'Accept': 'application/vnd.api+json',
                'Content-Type': 'application/vnd.api+json',
                'Authorization': `Bearer ${process.env.LEMONSQUEEZY_API_KEY}`
            },
            body: JSON.stringify({
                data: {
                    type: "checkouts",
                    attributes: {
                        checkout_data: {
                            email: userEmail,
                            custom: { user_email: userEmail } // Important: We pass the email to get it back later
                        }
                    },
                    relationships: {
                        store: { data: { type: "stores", id: process.env.LEMONSQUEEZY_STORE_ID } },
                        variant: { data: { type: "variants", id: process.env.LEMONSQUEEZY_VARIANT_ID } }
                    }
                }
            })
        });

        const data = await response.json();
        if (data.data && data.data.attributes) {
            res.json({ url: data.data.attributes.url });
        } else {
            console.error("LS Error:", data);
            res.status(500).json({ error: "Failed to create checkout" });
        }
    } catch (error) {
        console.error("Checkout Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// 5. THE NEW PART: Webhook (Listening for "Payment Success")
app.post('/api/webhook', async (req, res) => {
    try {
        console.log("🔔 Webhook received!");

        // A. Verify the Secret Password (Signature)
        const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
        const hmac = crypto.createHmac('sha256', secret);
        const digest = Buffer.from(hmac.update(req.rawBody).digest('hex'), 'utf8');
        const signature = Buffer.from(req.get('X-Signature') || '', 'utf8');

        if (!crypto.timingSafeEqual(digest, signature)) {
            console.log("❌ Invalid Webhook Signature (Password didn't match)");
            return res.status(401).send('Invalid signature');
        }

        // B. Read the Data
        const eventName = req.body.meta.event_name;
        const data = req.body.data;
        const customData = data.attributes.checkout_data?.custom; 
        const userEmail = customData?.user_email || data.attributes.user_email;

        console.log(`Event: ${eventName} for ${userEmail}`);

        // C. Unlock Premium in Database
        if (eventName === 'order_created' || eventName === 'subscription_created') {
            console.log(`🔓 Unlocking Premium for: ${userEmail}`);
            
            // Update Supabase
            const { error } = await supabase
                .from('profiles')
                .update({ 
                    is_premium: true,
                    premium_expiry: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).getTime() // +30 Days
                })
                .eq('email', userEmail);

            if (error) console.error("Database Update Error:", error);
            else console.log("✅ User is now PREMIUM!");
        }

        res.status(200).send('Webhook received');
    } catch (err) {
        console.error("Webhook Error:", err);
        res.status(500).send('Server Error');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server is running on port ${PORT}`);
});
module.exports = app;
