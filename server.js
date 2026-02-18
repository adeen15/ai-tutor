require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase client safely
let supabase;
try {
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
        supabase = createClient(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_SERVICE_ROLE_KEY
        );
        console.log("✅ Supabase client initialized");
    } else {
        console.warn("⚠️ Supabase credentials missing (SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY)");
    }
} catch (error) {
    console.error("❌ Supabase initialization failed:", error);
}

const app = express();
app.use(cors());
app.use(express.json({ 
    limit: '10mb',
    verify: (req, res, buf) => {
        if (req.originalUrl === '/api/webhook') {
            req.rawBody = buf;
        }
    }
}));
app.use(express.static(path.join(process.cwd())));

// --- VIEW ROUTES ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '2nd gemini app.html'));
});

app.get('/manifest.json', (req, res) => {
    res.sendFile(path.join(process.cwd(), 'manifest.json'));
});

app.get('/service-worker.js', (req, res) => {
    res.sendFile(path.join(process.cwd(), 'service-worker.js'));
});

// Fix favicon 404
app.get('/favicon.ico', (req, res) => res.status(204).end());

// --- CONFIG ROUTE ---
app.get('/api/config', (req, res) => {
    res.json({
        supabaseUrl: process.env.SUPABASE_URL,
        supabaseKey: process.env.SUPABASE_ANON_KEY
    });
});



// --- CHAT API ---
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
                "max_tokens": 150,
                "temperature": 0.6
            })
        });
        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error("Chat API Error:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// --- VISION API ---
app.post('/api/vision', async (req, res) => {
    try {
        const { prompt, image, systemInstruction } = req.body;
        // image is now expected to be a full Data URL (e.g., "data:image/jpeg;base64,.....")
        
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                "model": "google/gemini-2.0-flash-001",
                "messages": [
                    { "role": "system", "content": systemInstruction },
                    {
                        "role": "user",
                        "content": [
                            { "type": "text", "text": prompt },
                            {
                                "type": "image_url",
                                "image_url": {
                                    "url": image // Pass the full data URL directly
                                }
                            }
                        ]
                    }
                ]
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error(`upstream API error: ${response.status} ${response.statusText}`, errText);
            throw new Error(`Upstream API failed: ${response.status} ${errText}`);
        }

        const data = await response.json();
        res.json({ response: data.choices[0].message.content });
    } catch (error) {
        console.error("Vision API Error:", error);
        res.status(500).json({ error: "Vision analysis failed: " + error.message });
    }
});

// --- EMAIL API ---
app.post('/api/send-email', async (req, res) => {
    const { to, subject, body } = req.body;
    console.log(`Simulating email to ${to}: ${subject}`);
    res.json({ success: true, message: "Summary logged to server console." });
});

// --- LEMON SQUEEZY CHECKOUT ---
app.post('/api/create-checkout', async (req, res) => {
    try {
        const { userEmail } = req.body;
        console.log(`Creating checkout for: ${userEmail}`);
        
        const requiredVars = [
            'LEMONSQUEEZY_API_KEY',
            'LEMONSQUEEZY_STORE_ID',
            'LEMONSQUEEZY_VARIANT_ID'
        ];
        
        const missingVars = requiredVars.filter(v => !process.env[v]);
        if (missingVars.length > 0) {
            console.error(`Missing LemonSqueezy configuration: ${missingVars.join(', ')}`);
            return res.status(500).json({ error: "Server configuration missing", missing: missingVars });
        }

        if (!userEmail) {
            return res.status(400).json({ error: "userEmail is required" });
        }
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
                        store_id: parseInt(process.env.LEMONSQUEEZY_STORE_ID),
                        variant_id: parseInt(process.env.LEMONSQUEEZY_VARIANT_ID),
                        checkout_data: {
                            email: userEmail,
                            custom: { user_email: userEmail },
                            redirect_url: req.get('origin') || `${req.protocol}://${req.get('host')}`
                        }
                    }
                }
            })
        });

        const data = await response.json();
        console.log("LemonSqueezy Response Status:", response.status);
        if (!response.ok) {
            console.error("LemonSqueezy Error Body:", JSON.stringify(data, null, 2));
            return res.status(response.status).json({ error: "LemonSqueezy API error", details: data });
        }

        if (data.data) res.json({ url: data.data.attributes.url });
        else res.status(500).json({ error: "Checkout failed, no URL returned" });
    } catch (error) {
        console.error("Checkout Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// --- LEMON SQUEEZY WEBHOOK ---
app.post('/api/webhook', async (req, res) => {
    try {
        const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
        if (!secret) {
            console.error('Webhook secret missing');
            return res.status(500).send('Webhook secret missing');
        }

        if (!req.rawBody) {
            console.error('Raw body missing for webhook verification');
            return res.status(400).send('Raw body missing');
        }

        const hmac = crypto.createHmac('sha256', secret);
        const digest = Buffer.from(hmac.update(req.rawBody).digest('hex'), 'utf8');
        const signature = Buffer.from(req.get('x-signature') || '', 'utf8');

        if (!crypto.timingSafeEqual(digest, signature)) {
            console.error('Invalid signature');
            return res.status(401).send('Invalid signature');
        }

        const payload = req.body; // express.json has already parsed this
        const eventName = payload.meta.event_name;
        const userEmail = payload.meta.custom_data.user_email;

        console.log(`Webhook received: ${eventName} for ${userEmail}`);

        if ((eventName === 'order_created' || eventName === 'subscription_created') && supabase) {
            const { error } = await supabase
                .from('profiles')
                .update({ is_premium: true })
                .eq('email', userEmail);

            if (error) {
                console.error('Error updating Supabase:', error);
                return res.status(500).send('Database update failed');
            }
            console.log(`Successfully upgraded user ${userEmail} to premium`);
        }

        res.status(200).send('OK');
    } catch (error) {
        console.error('Webhook Error:', error);
        res.status(500).send('Internal Server Error');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ AI Tutor Server is running on port ${PORT}`);
});

module.exports = app;
