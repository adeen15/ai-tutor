require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

// --- VIEW ROUTES ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '2nd gemini app.html'));
});

// --- CONFIG ROUTE ---
app.get('/api/config', (req, res) => {
    res.json({
        supabaseUrl: process.env.SUPABASE_URL,
        supabaseKey: process.env.SUPABASE_ANON_KEY
    });
});

// --- ART GENERATION ROUTE ---
app.post('/api/generate-image', async (req, res) => {
    try {
        const { prompt } = req.body;
        
        // Check for API Key
        const apiKey = process.env.POLLINATIONS_API_KEY;
        
        // DEBUG LOG: Check Vercel logs to see if this says "FOUND" or "MISSING"
        if (apiKey) {
            console.log("✅ POLLINATIONS_API_KEY found in environment variables.");
        } else {
            console.warn("⚠️ POLLINATIONS_API_KEY is MISSING. Rate limits will apply.");
        }

        if (!prompt) return res.status(400).json({ error: "Prompt is required" });

        // FIX 1: Random Seed to prevent caching the "Limit Reached" image
        const seed = Math.floor(Math.random() * 1000000);
        
        // FIX 2: Use 'turbo' model instead of 'flux'. 
        // 'flux' is too slow for Vercel Free Tier (10s timeout) and causes 504 errors.
        // 'turbo' is fast and less likely to hit strict rate limits.
        const encodedPrompt = encodeURIComponent(prompt);
        const url = `https://image.pollinations.ai/prompt/${encodedPrompt}?nologo=true&private=true&enhance=false&model=turbo&seed=${seed}`;

        const headers = {
            'User-Agent': 'AI-Tutor-App/1.0',
            'Referer': 'https://pollinations.ai/'
        };

        if (apiKey) {
            headers['Authorization'] = `Bearer ${apiKey}`;
        }

        console.log(`[VERCEL-DEBUG] Requesting URL: ${url}`);
        
        // Setup timeout (Vercel free tier is strict 10s, but we set 15s just in case)
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000); 

        const response = await fetch(url, {
            method: 'GET',
            headers: headers,
            signal: controller.signal
        });
        clearTimeout(timeout);

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Pollinations API Error: ${response.status} - ${errorText}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const base64 = buffer.toString('base64');
        const dataUrl = `data:image/jpeg;base64,${base64}`;

        res.json({ image: dataUrl });

    } catch (error) {
        console.error("Image Generation Error:", error);
        
        if (error.name === 'AbortError' || error.message.includes('aborted')) {
             return res.status(504).json({ error: "The magic paint took too long to dry! Please try again. 🎨" });
        }
        
        res.status(500).json({ error: error.message || "Failed to generate image." });
    }
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
                                    "url": `data:image/jpeg;base64,${image}`
                                }
                            }
                        ]
                    }
                ]
            })
        });
        const data = await response.json();
        res.json({ response: data.choices[0].message.content });
    } catch (error) {
        console.error("Vision API Error:", error);
        res.status(500).json({ error: "Vision analysis failed" });
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
