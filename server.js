require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());

// Raw body middleware for Webhook Verification
app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));

app.use(express.static(__dirname));

// Initialize Supabase
// We use a check here to prevent crashing if keys are missing during build
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
let supabase;

if (supabaseUrl && supabaseKey) {
    supabase = createClient(supabaseUrl, supabaseKey);
} else {
    console.log("⚠️ Supabase Keys missing. Database features will not work.");
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '2nd gemini app.html'));
});

app.get('/api/config', (req, res) => {
    res.json({
        supabaseUrl: process.env.SUPABASE_URL,
        supabaseKey: process.env.SUPABASE_ANON_KEY
    });
});

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

app.post('/api/create-checkout', async (req, res) => {
    try {
        const { userEmail } = req.body;
        console.log("Creating checkout for:", userEmail); 

        // UPDATED: Now includes the secret signal "?payment=success"
        const APP_URL = "https://ai-tutor-murex.vercel.app/?payment=success"; 

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
                            custom: { user_email: userEmail }
                        },
                        // This puts the redirect link in the correct place
                        product_options: {
                            redirect_url: APP_URL
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
        
        if (data.errors) {
            console.error("LS Error:", JSON.stringify(data.errors, null, 2));
            return res.status(500).json({ error: data.errors[0].detail });
        }

        if (data.data && data.data.attributes) {
            res.json({ url: data.data.attributes.url });
        } else {
            res.status(500).json({ error: "Failed to create checkout" });
        }
    } catch (error) {
        console.error("Checkout Error:", error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/webhook', async (req, res) => {
    try {
        console.log("🔔 Webhook received!");

        const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
        
        if (!secret) {
            console.error("❌ Webhook Secret is MISSING in Vercel.");
            return res.status(500).send("Server Configuration Error");
        }

        const hmac = crypto.createHmac('sha256', secret);
        const digest = Buffer.from(hmac.update(req.rawBody).digest('hex'), 'utf8');
        const signature = Buffer.from(req.get('X-Signature') || '', 'utf8');

        if (!crypto.timingSafeEqual(digest, signature)) {
            console.log("❌ Invalid Webhook Signature.");
            return res.status(401).send('Invalid signature');
        }

        const eventName = req.body.meta.event_name;
        const data = req.body.data;
        const customData = data.attributes.checkout_data?.custom; 
        const userEmail = customData?.user_email || data.attributes.user_email;

        console.log(`Event: ${eventName} for ${userEmail}`);

        if (eventName === 'order_created' || eventName === 'subscription_created') {
            if (!supabase) {
                console.error("❌ Cannot unlock premium: Supabase client not initialized.");
                return res.status(500).send("Database Error");
            }

            console.log(`🔓 Unlocking Premium for: ${userEmail}`);
            
            const { error } = await supabase
                .from('profiles')
                .update({ 
                    is_premium: true,
                    premium_expiry: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).getTime()
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
