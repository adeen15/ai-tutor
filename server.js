require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
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
        console.error("Checkout Error:", error);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ AI Tutor Server is running on port ${PORT}`);
});

module.exports = app;
