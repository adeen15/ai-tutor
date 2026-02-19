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
                "temperature": 0.6,
                "response_format": { "type": "json_object" }
            })
        });
        const data = await response.json();
        if (data.choices && data.choices[0]) {
            res.json({ response: data.choices[0].message.content });
        } else {
            console.error("OpenRouter Unexpected Response:", data);
            res.status(500).json({ error: "Invalid response from AI provider" });
        }
    } catch (error) {
        console.error("Chat API Error:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// --- CLOUD VOICE APIs (ElevenLabs & Deepgram) ---
app.post('/api/tts', async (req, res) => {
    try {
        const { text, voiceId } = req.body;
        const vId = voiceId ? voiceId.trim() : "pNInz6obpgDQGcFmaJgB";
        const rawKey = process.env.ELEVEN_LABS_API_KEY;
        const apiKey = rawKey ? rawKey.trim() : null;

        // Use console.error to force visibility in filtered Vercel logs
        console.error(`DEBUG: TTS Request. Text: ${text.substring(0, 20)}... Voice: ${vId}`);

        if (!apiKey || apiKey === 'your_elevenlabs_key_here') {
            const errorMsg = "❌ ElevenLabs API key is missing or set to placeholder.";
            console.error(errorMsg);
            return res.status(500).json({ error: errorMsg });
        }
        
        console.error(`DEBUG: Key Length: ${apiKey.length}. Prefix: ${apiKey.substring(0, 4)}...`);

        const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vId}`, {
            method: 'POST',
            headers: {
                'Xi-Api-Key': apiKey,
                'Content-Type': 'application/json',
                'Accept': 'audio/mpeg'
            },
            body: JSON.stringify({
                text,
                model_id: "eleven_monolingual_v1",
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
        const rawKey = process.env.DEEPGRAM_API_KEY;
        const apiKey = rawKey ? rawKey.trim() : null;

        if (!apiKey || apiKey === 'your_deepgram_key_here') {
            console.error("❌ Deepgram API key is missing or placeholder");
            return res.status(500).json({ error: "Deepgram API key not configured" });
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
