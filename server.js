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
// --- ART GENERATION ROUTE (Hugging Face - Free Tier with Retry) ---
app.post('/api/generate-image', async (req, res) => {
    const fetchWithRetry = async (url, options, retries = 3) => {
        for (let i = 0; i < retries; i++) {
            const response = await fetch(url, options);
            
            if (response.status === 503) {
                const errorData = await response.json();
                const waitTime = errorData.estimated_time || 20;
                console.log(`Model loading... waiting ${waitTime}s (Attempt ${i + 1}/${retries})`);
                await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
                continue;
            }

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Hugging Face API Error: ${response.status} - ${errorText}`);
            }

            return response;
        }
        throw new Error("Model took too long to load. Please try again.");
    };

    try {
        const { prompt } = req.body;
        // Check for Hugging Face API Key
        if (!process.env.HUGGINGFACE_API_KEY) {
            console.error("Hugging Face API Key is missing.");
            return res.status(500).json({ error: "Server Config Error: HUGGINGFACE_API_KEY Missing" });
        }
        if (!prompt) return res.status(400).json({ error: "Prompt is required" });

        // Using Hugging Face Inference API (FLUX.1-schnell - Best Free Tier Model)
        // URL: https://router.huggingface.co/models/black-forest-labs/FLUX.1-schnell
        const response = await fetchWithRetry(
            "https://router.huggingface.co/models/black-forest-labs/FLUX.1-schnell",
            {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${process.env.HUGGINGFACE_API_KEY}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ inputs: prompt }),
            }
        );

        // Hugging Face returns the image directly as a blob/buffer
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const base64 = buffer.toString('base64');
        const dataUrl = `data:image/jpeg;base64,${base64}`;

        res.json({ image: dataUrl });

    } catch (error) {
        console.error("Image Generation Error:", error);
        // Return the ACTUAL error message for debugging
        res.status(500).json({ error: error.message || "Failed to generate image." });
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
