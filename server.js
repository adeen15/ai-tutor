require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

// --- DEBUG CHECK STARTS HERE ---
console.log("-----------------------------------");
console.log("🔍 Checking Server Configuration...");

// 1. Check Supabase
if (process.env.SUPABASE_URL) console.log("✅ SUPABASE_URL: Loaded");
else console.log("❌ SUPABASE_URL: MISSING");

if (process.env.SUPABASE_ANON_KEY) console.log("✅ SUPABASE_ANON_KEY: Loaded");
else console.log("❌ SUPABASE_ANON_KEY: MISSING");

// 2. Check Lemon Squeezy Keys
const lemonKey = process.env.LEMONSQUEEZY_API_KEY;
if (lemonKey) {
    console.log(`✅ LEMON KEY: Loaded (Length: ${lemonKey.length} chars)`);
    // Warning if key looks too short (it should be long)
    if (lemonKey.length < 20) console.log("⚠️ WARNING: Your Lemon Key looks too short. Did you paste the Store ID?");
} else {
    console.log("❌ LEMON KEY: MISSING");
}

if (process.env.LEMONSQUEEZY_STORE_ID) console.log("✅ LEMON STORE ID: Loaded");
else console.log("❌ LEMON STORE ID: MISSING");

if (process.env.LEMONSQUEEZY_VARIANT_ID) console.log("✅ LEMON VARIANT ID: Loaded");
else console.log("❌ LEMON VARIANT ID: MISSING");

console.log("-----------------------------------");
// --- DEBUG CHECK ENDS HERE ---

const app = express();
app.use(cors());
app.use(express.json());

// Serve static files
app.use(express.static(__dirname));

// Serving the HTML file
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

        // Double check key before sending
        if (!process.env.LEMONSQUEEZY_API_KEY) {
            throw new Error("API Key is missing on Server!");
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
        
        if (data.errors) {
            console.error("Lemon Squeezy API Error:", JSON.stringify(data.errors, null, 2));
            // Send the actual error to the frontend so you can see it in the console
            return res.status(500).json({ error: data.errors[0].detail, fullError: data.errors });
        }

        if (data.data && data.data.attributes) {
            res.json({ url: data.data.attributes.url });
        } else {
            res.status(500).json({ error: "Failed to create checkout" });
        }
        
    } catch (error) {
        console.error("Server Checkout Error:", error);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server is running on port ${PORT}`);
});
module.exports = app;