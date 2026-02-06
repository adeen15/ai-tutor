require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '2nd gemini app.html'));
});

app.get('/api/config', (req, res) => {
    res.json({
        supabaseUrl: process.env.SUPABASE_URL,
        supabaseKey: process.env.SUPABASE_ANON_KEY
    });
});

// --- UPDATED FAST IMAGE ROUTE ---
app.get('/api/generate-image', (req, res) => {
    const prompt = req.query.prompt;
    const seed = req.query.seed || Math.floor(Math.random() * 1000);
    const apiKey = process.env.POLLINATIONS_API_KEY;

    const encodedPrompt = encodeURIComponent(prompt);
    
    // Construct the URL directly. gen.pollinations.ai/image/ is the stable 2026 endpoint.
    let finalUrl = `https://gen.pollinations.ai/image/${encodedPrompt}?nologo=true&seed=${seed}`;
    
    if (apiKey) {
        finalUrl += `&key=${apiKey}`;
    }

    // Return the URL as JSON so the browser can load it directly (prevents Vercel timeouts)
    res.json({ imageUrl: finalUrl });
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
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.post('/api/create-checkout', async (req, res) => {
    try {
        const { userEmail } = req.body;
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
        if (data.data) res.json({ url: data.data.attributes.url });
        else res.status(500).json({ error: "Checkout failed" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server is running on port ${PORT}`);
});
module.exports = app;
