require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

// --- DEBUG CHECK STARTS HERE ---
console.log("-----------------------------------");
console.log("🔍 Checking Server Configuration...");

if (process.env.SUPABASE_URL) {
    console.log("✅ SUPABASE_URL is loaded");
} else {
    console.log("❌ ERROR: SUPABASE_URL is MISSING! Check your .env file.");
}

if (process.env.SUPABASE_ANON_KEY) {
    console.log("✅ SUPABASE_ANON_KEY is loaded");
} else {
    console.log("❌ ERROR: SUPABASE_ANON_KEY is MISSING! Check your .env file.");
}

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

// Endpoint to send Supabase config to frontend safely
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server is running on port ${PORT}`);
});
module.exports = app;