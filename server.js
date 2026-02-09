require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' })); // Increased limit for base64 images
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
// --- UPDATED ART GENERATION ROUTE ---
// --- NEW PLAYGROUND AI ART ROUTE ---
// --- UPDATED ART GENERATION ROUTE (PLAYGROUND AI V3) ---
// --- UPDATED ART GENERATION ROUTE (MAGE.SPACE OPTIMIZED) ---
// --- UPDATED ART GENERATION ROUTE (MAGE.SPACE / SDXL OPTIMIZED) ---
// --- ART GENERATION ROUTE (MOVED TO CLIENT-SIDE PUTER.JS) ---
// --- ART GENERATION ROUTE (OpenRouter) ---
app.post('/api/generate-image', async (req, res) => {
    try {
        const { prompt } = req.body;
        if (!process.env.OPENROUTER_API_KEY) {
            console.error("OpenRouter API Key is missing in server environment.");
            return res.status(500).json({ error: "Server Error: API Key Missing" });
        }
        if (!prompt) return res.status(400).json({ error: "Prompt is required" });

        // Using OpenRouter's image generation endpoint (OpenAI compatible)
        const response = await fetch("https://openrouter.ai/api/v1/images/generations", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
                "Content-Type": "application/json",
                "HTTP-Referer": "https://github.com/adeen/ai-tutor", // Required by OpenRouter
                "X-Title": "AI Tutor"
            },
            body: JSON.stringify({
                model: "stabilityai/stable-diffusion-xl-base-1.0",
                prompt: prompt,
                n: 1,
                size: "1024x1024", 
                response_format: "b64_json"
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`OpenRouter API Error: ${response.status} - ${errorText}`);
        }

        const data = await response.json();
        const image = data.data[0].b64_json || data.data[0].url; // Handle both base64 and URL
        
        // If it's a URL, we might want to fetch it and convert to base64 to avoid CORS on client
        // but for now let's hope for b64_json support or return the URL
        const finalImage = image.startsWith('http') ? image : `data:image/png;base64,${image}`;

        res.json({ image: finalImage });

    } catch (error) {
        console.error("Image Generation Error:", error);
        res.status(500).json({ error: "Failed to generate image. Please try again." });
    }
});

// --- CHAT API (Standard Questions) ---
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

// --- VISION API (Analyze Homework/Drawings) ---
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

// --- EMAIL API (Parent Portal Summaries) ---
app.post('/api/send-email', async (req, res) => {
    // This is a placeholder for your email logic (e.g., SendGrid or Nodemailer)
    // For now, it logs the request so your frontend doesn't crash
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
