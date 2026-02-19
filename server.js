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

// Utility to clean and normalize API keys
function normalizeKey(key) {
    if (!key) return null;
    let clean = key.trim();
    // Remove surrounding quotes if the user accidentally pasted them
    clean = clean.replace(/^["']|["']$/g, '');
    // Remove ALL spaces (helpful if copy-pasted with weird formatting)
    clean = clean.replace(/\s+/g, '');
    
    // Fix common copy-paste issue where sk_ becomes sk (space)
    // ONLY apply this to legacy keys that are purely alphanumeric after 'sk'
    // OpenRouter keys (sk-or-v1-...) should NOT be touched if they already have the prefix
    if (clean.startsWith('sk') && !clean.startsWith('sk_') && !clean.startsWith('sk-')) {
        clean = 'sk_' + clean.substring(2);
    }
    return clean;
}

// =============================================
// SERVER-SIDE CONTENT MODERATION
// Two-layer defense for child safety:
//   Layer 1 — OpenAI Moderation API (free, optional — set OPENAI_API_KEY in Vercel)
//   Layer 2 — Keyword filter (always active, no key required)
// =============================================

const BLOCKED_TERMS = [
    // Violence & weapons
    'kill', 'murder', 'shoot', 'stab', 'gun', 'knife', 'bomb', 'explode', 'attack', 'weapon',
    'assassin', 'sniper', 'grenade', 'suicide', 'hang myself', 'hurt myself', 'cut myself',
    // Adult / sexual content
    'sex', 'porn', 'naked', 'nude', 'boobs', 'penis', 'vagina', 'condom', 'orgasm',
    'rape', 'molest', 'prostitute', 'escort', 'stripper', 'masturbat',
    // Drugs & alcohol
    'cocaine', 'heroin', 'meth', 'drug dealer', 'weed', 'marijuana', 'ecstasy', 'lsd',
    'overdose', 'get high', 'get drunk', 'alcohol', 'cigarette', 'vape', 'smoke weed',
    // Hate & discrimination
    'racist', 'nigger', 'faggot', 'slur', 'white supremacy', 'neo nazi', 'terrorist',
    // Horror / disturbing
    'demon', 'satanic', '666', 'possessed', 'torture', 'gore', 'bloody corpse',
    // Self-harm
    'self harm', 'self-harm', 'want to die', 'end my life', 'kill myself',
    // Bypassing the AI
    'ignore your instructions', 'ignore previous', 'jailbreak', 'act as dan',
    'you are now', 'pretend you have no', 'disregard all prior'
];

async function moderateText(text) {
    if (!text || typeof text !== 'string') return { blocked: false };
    const lower = text.toLowerCase();

    // --- LAYER 1: OpenAI Moderation API (free, optional) ---
    const openAiKey = normalizeKey(process.env.OPENAI_API_KEY);
    if (openAiKey) {
        try {
            const modRes = await fetch('https://api.openai.com/v1/moderations', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${openAiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ input: text })
            });
            if (modRes.ok) {
                const modData = await modRes.json();
                const result = modData.results && modData.results[0];
                if (result && result.flagged) {
                    const flaggedCats = Object.entries(result.categories)
                        .filter(([, v]) => v)
                        .map(([k]) => k)
                        .join(', ');
                    console.warn(`🚫 [Moderation-L1] Blocked by OpenAI. Categories: ${flaggedCats}`);
                    return { blocked: true, layer: 'openai', categories: flaggedCats };
                }
            }
        } catch (err) {
            // Non-fatal — fall through to Layer 2 if OpenAI call fails
            console.warn('⚠️ [Moderation-L1] OpenAI check failed, falling back to keyword filter:', err.message);
        }
    }

    // --- LAYER 2: Keyword Filter (always runs) ---
    for (const term of BLOCKED_TERMS) {
        // Use word-boundary check to avoid false positives (e.g. "class" won't match "ass")
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(`(^|\\s|\\b)${escaped}(\\s|\\b|$)`, 'i');
        if (pattern.test(lower)) {
            console.warn(`🚫 [Moderation-L2] Blocked keyword: "${term}"`);
            return { blocked: true, layer: 'keyword', term };
        }
    }

    return { blocked: false };
}

const BLOCKED_RESPONSE = {
    blocked: true,
    response: JSON.stringify({
        response: "Oops! That's not something I can help with. Let's talk about something fun like dinosaurs, space, or math instead! 🌟🦕",
        emotion: "neutral"
    })
};

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

app.get('/api/health', (req, res) => {
    res.json({ status: "ok", version: "voice-debug-v1", time: new Date().toISOString() });
});




// --- CHAT API ---
app.post('/api/chat', async (req, res) => {
    try {
        const { messages } = req.body;
        const apiKey = normalizeKey(process.env.OPENROUTER_API_KEY);

        if (!apiKey || apiKey === 'your_openrouter_key_here') {
            console.error("❌ OpenRouter API key is missing or placeholder value.");
            return res.status(500).json({ error: "OpenRouter API key is missing or invalid." });
        }

        // --- SERVER-SIDE MODERATION ---
        // Extract the last user message to check (system prompts are trusted, skip them)
        const userMessages = (messages || []).filter(m => m.role === 'user');
        const lastUserText = userMessages.length > 0 ? userMessages[userMessages.length - 1].content : '';
        if (lastUserText) {
            const modResult = await moderateText(lastUserText);
            if (modResult.blocked) {
                return res.status(451).json(BLOCKED_RESPONSE);
            }
        }

        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json",
                "HTTP-Referer": "https://ai-tutor-animated.vercel.app", // Optional for OpenRouter rankings
                "X-Title": "AI Tutor"
            },
            body: JSON.stringify({
                "model": "google/gemini-2.0-flash-001",
                "messages": messages,
                "max_tokens": 500,
                "temperature": 0.6,
                "response_format": { "type": "json_object" }
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`❌ OpenRouter API Error (${response.status}):`, errorText);
            return res.status(response.status).json({ error: "AI Provider Error", details: errorText });
        }

        const data = await response.json();
        if (data.choices && data.choices[0]) {
            res.json({ response: data.choices[0].message.content });
        } else {
            console.error("❌ OpenRouter Unexpected JSON Response:", data);
            res.status(500).json({ error: "Invalid response structure from AI provider" });
        }
    } catch (error) {
        console.error("❌ Chat API Exception:", error);
        res.status(500).json({ error: "Internal Server Error", message: error.message });
    }
});

// --- CLOUD VOICE APIs (ElevenLabs & Deepgram) ---

app.post('/api/tts', async (req, res) => {
    try {
        const { text, voiceId } = req.body;
        const vId = voiceId ? voiceId.trim() : "pNInz6obpgDQGcFmaJgB";
        const apiKey = normalizeKey(process.env.ELEVEN_LABS_API_KEY);

        if (!apiKey || apiKey === 'your_elevenlabs_key_here') {
            return res.status(500).json({ error: "ElevenLabs API key is missing or invalid." });
        }
        
        // Log the key format for debugging (masked)
        console.error(`🎙️ ElevenLabs TTS. Key: ${apiKey.substring(0, 10)}...${apiKey.slice(-5)} (Total: ${apiKey.length}). Voice: ${vId}`);


        const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vId}`, {
            method: 'POST',
            headers: {
                'xi-api-key': apiKey,
                'Content-Type': 'application/json',
                'accept': 'audio/mpeg'
            },
            body: JSON.stringify({
                text,
                model_id: "eleven_multilingual_v2",
                voice_settings: {
                    stability: 0.5,
                    similarity_boost: 0.75
                }
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            console.error("❌ ElevenLabs API Error:", JSON.stringify(errorData, null, 2));
            return res.status(response.status).json({ 
                error: "ElevenLabs API failed", 
                details: errorData.detail || errorData 
            });
        }

        const audioBuffer = await response.arrayBuffer();
        res.set('Content-Type', 'audio/mpeg');
        res.send(Buffer.from(audioBuffer));
    } catch (error) {
        console.error("❌ TTS Endpoint Error:", error);
        res.status(500).json({ error: "TTS processing failed", message: error.message });
    }
});

app.post('/api/stt', async (req, res) => {
    try {
        const { audio } = req.body;
        const apiKey = normalizeKey(process.env.DEEPGRAM_API_KEY || process.env.ELEVEN_LABS_API_KEY);

        if (!apiKey || apiKey === 'your_deepgram_key_here') {
            return res.status(500).json({ error: "STT API key not configured." });
        }

        const buffer = Buffer.from(audio, 'base64');
        const response = await fetch("https://api.deepgram.com/v1/listen?smart_format=true&model=nova-2&language=en", {
            method: "POST",
            headers: {
                "Authorization": `Token ${apiKey}`,
                "Content-Type": "audio/wav"
            },
            body: buffer
        });

        const data = await response.json();
        if (!response.ok) {
            console.error("❌ Deepgram API Error:", JSON.stringify(data, null, 2));
            return res.status(response.status).json({ error: "Deepgram API failed", details: data });
        }

        const transcript = data.results?.channels[0]?.alternatives[0]?.transcript || "";
        console.log(`🎤 STT Success: "${transcript}"`);
        res.json({ transcript });
    } catch (error) {
        console.error("❌ STT Endpoint Error:", error);
        res.status(500).json({ error: "STT processing failed", message: error.message });
    }
});






// --- VISION API ---
app.post('/api/vision', async (req, res) => {
    try {
        const { prompt, image, systemInstruction } = req.body;
        const apiKey = normalizeKey(process.env.OPENROUTER_API_KEY);

        if (!apiKey || apiKey === 'your_openrouter_key_here') {
            console.error("❌ OpenRouter API key missing for vision endpoint.");
            return res.status(500).json({ error: "AI configuration missing." });
        }

        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json",
                "HTTP-Referer": "https://ai-tutor-animated.vercel.app",
                "X-Title": "AI Tutor"
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
                ],
                "response_format": { "type": "json_object" }
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error(`upstream API error: ${response.status} ${response.statusText}`, errText);
            throw new Error(`Upstream API failed: ${response.status} ${errText}`);
        }

        const data = await response.json();
        if (data.choices && data.choices[0]) {
            res.json({ response: data.choices[0].message.content });
        } else {
            console.error("OpenRouter Vision Unexpected Response:", data);
            res.status(500).json({ error: "Invalid vision response from AI provider" });
        }
    } catch (error) {
        console.error("Vision API Error:", error);
        res.status(500).json({ error: "Vision analysis failed: " + error.message });
    }
});

// --- EMAIL API ---
app.post('/api/send-email', async (req, res) => {
    try {
        const { to, subject, body } = req.body;
        
        if (!process.env.RESEND_API_KEY) {
            console.error("RESEND_API_KEY missing");
            return res.status(500).json({ error: "Email configuration missing" });
        }

        // --- Robust Report Parser ---
        const sections = {
            intro: [],
            milestones: [],
            subjects: [],
            curiosity: [],
            conclusion: []
        };

        const lines = body.split('\n').map(l => l.trim()).filter(l => l !== '' && !l.startsWith('---'));
        let currentSection = 'intro';

        lines.forEach(line => {
            if (line.includes('🏆 LEARNING MILESTONES')) currentSection = 'milestones';
            else if (line.includes('📚 SUBJECT BREAKDOWN')) currentSection = 'subjects';
            else if (line.includes('📝 RECENT CURIOSITY')) currentSection = 'curiosity';
            else if (line.includes('This report verifies active engagement')) currentSection = 'conclusion';
            else {
                sections[currentSection].push(line.replace(/^- /, ''));
            }
        });

        // --- Milestone Styling (Cards) ---
        const milestoneHtml = sections.milestones.map(m => {
            const [label, value] = m.split(':');
            return `
                <div style="background-color: #ffffff; border: 1px solid #f1f5f9; border-radius: 12px; padding: 16px; margin-bottom: 12px; box-shadow: 0 1px 2px rgba(0,0,0,0.05);">
                    <div style="color: #64748b; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;">${label || ''}</div>
                    <div style="color: #4f46e5; font-size: 20px; font-weight: 700; margin-top: 4px;">${value || ''}</div>
                </div>
            `;
        }).join('');

        // --- Subject Styling (List) ---
        const subjectsHtml = sections.subjects.map(s => {
            const [name, score] = s.split(':');
            return `
                <div style="display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f1f5f9;">
                    <span style="color: #334155; font-weight: 500;">${name || ''}</span>
                    <span style="color: #6366f1; font-weight: 700;">${score || ''}</span>
                </div>
            `;
        }).join('');

        const htmlContent = `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
                <style>
                    @media only screen and (max-width: 600px) {
                        .container { width: 100% !important; border-radius: 0 !important; }
                    }
                </style>
            </head>
            <body style="margin: 0; padding: 0; background-color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
                <table width="100%" border="0" cellspacing="0" cellpadding="0">
                    <tr>
                        <td align="center" style="padding: 24px 0;">
                            <div class="container" style="max-width: 600px; width: 95%; background-color: #ffffff; border-radius: 24px; overflow: hidden; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1);">
                                <!-- Header Hero -->
                                <div style="background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%); padding: 48px 32px; text-align: center;">
                                    <div style="background-color: rgba(255,255,255,0.2); width: 80px; height: 80px; border-radius: 20px; margin: 0 auto 16px auto; display: flex; align-items: center; justify-content: center; font-size: 44px;">
                                        🎓
                                    </div>
                                    <h1 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: 800;">Learning Journey</h1>
                                    <p style="color: rgba(255,255,255,0.8); margin: 8px 0 0 0; font-size: 16px;">Verified Progress Report</p>
                                </div>

                                <!-- Content area -->
                                <div style="padding: 32px;">
                                    <!-- Intro -->
                                    <div style="margin-bottom: 32px; border-left: 4px solid #4f46e5; padding-left: 16px;">
                                        <div style="color: #64748b; font-size: 14px;">${sections.intro[1] || ''}</div>
                                        <div style="color: #0f172a; font-size: 24px; font-weight: 800; margin-top: 4px;">${sections.intro[0] || ''}</div>
                                    </div>

                                    <!-- Milestones Section -->
                                    <h3 style="color: #0f172a; font-size: 18px; font-weight: 700; margin-bottom: 16px;">🏆 Key Achievements</h3>
                                    <div style="display: block;">
                                        ${milestoneHtml}
                                    </div>

                                    <!-- Subjects Section -->
                                    <div style="margin-top: 32px; background-color: #f8fafc; border-radius: 16px; padding: 24px;">
                                        <h3 style="color: #0f172a; font-size: 18px; font-weight: 700; margin-top: 0; margin-bottom: 16px;">📚 Subject Mastery</h3>
                                        ${subjectsHtml}
                                    </div>

                                    <!-- Curiosity Section -->
                                    <div style="margin-top: 32px;">
                                        <h3 style="color: #0f172a; font-size: 18px; font-weight: 700; margin-bottom: 16px;">📝 Recent Curiosity</h3>
                                        <div style="background-color: #eff6ff; border-radius: 16px; padding: 20px; position: relative;">
                                            <div style="color: #1d4ed8; font-size: 15px; font-style: italic; line-height: 1.6;">
                                                "${sections.curiosity[0] || ''}"
                                            </div>
                                        </div>
                                    </div>

                                    <!-- Verification Footer -->
                                    <div style="margin-top: 40px; padding-top: 24px; border-top: 1px solid #f1f5f9; text-align: center;">
                                        <div style="color: #10b981; font-weight: 700; font-size: 14px; display: inline-flex; align-items: center;">
                                            <span style="margin-right: 6px;">✅</span> VERIFIED BY AI TUTOR
                                        </div>
                                        <p style="color: #64748b; font-size: 12px; margin-top: 12px; line-height: 1.5;">
                                            ${sections.conclusion[0] || ''}
                                        </p>
                                    </div>
                                </div>

                                <!-- Final Footer -->
                                <div style="background-color: #f1f5f9; padding: 32px; text-align: center;">
                                    <p style="color: #94a3b8; font-size: 12px; margin: 0;">
                                        &copy; ${new Date().getFullYear()} AI Tutor. Dedicated to your child's success.
                                    </p>
                                    <div style="margin-top: 12px; color: #cbd5e1; font-size: 12px;">
                                        Premium Parent Portal &bull; Weekly Analytics &bull; Educational Guidance
                                    </div>
                                </div>
                            </div>
                        </td>
                    </tr>
                </table>
            </body>
            </html>
        `;

        const response = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.RESEND_API_KEY}`
            },
            body: JSON.stringify({
                from: 'AI Tutor <onboarding@resend.dev>',
                to: [to],
                subject: subject,
                html: htmlContent
            })
        });

        const data = await response.json();
        
        if (response.ok) {
            console.log(`Email sent successfully to ${to}: ${data.id}`);
            res.json({ success: true, message: "Email sent successfully!", id: data.id });
        } else {
            console.error("Resend API Error:", data);
            res.status(response.status).json({ error: "Failed to send email", details: data });
        }
    } catch (error) {
        console.error("Email API Error:", error);
        res.status(500).json({ error: error.message });
    }
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
                        product_options: {
                            redirect_url: req.get('origin') || `${req.protocol}://${req.get('host')}`
                        },
                        checkout_data: {
                            email: userEmail,
                            custom: { user_email: userEmail }
                        }
                    },
                    relationships: {
                        store: {
                            data: {
                                type: "stores",
                                id: String(process.env.LEMONSQUEEZY_STORE_ID)
                            }
                        },
                        variant: {
                            data: {
                                type: "variants",
                                id: String(process.env.LEMONSQUEEZY_VARIANT_ID)
                            }
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
