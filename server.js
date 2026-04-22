require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const webpush = require('web-push');

// --- In-Memory Rate Limiter (no external dependencies, works on Vercel) ---
const rateLimitStore = {};

function rateLimit(windowMs, maxRequests) {
    return (req, res, next) => {
        const ip = req.headers['x-forwarded-for'] || req.connection?.remoteAddress || 'unknown';
        const key = `${ip}:${req.route?.path || req.path}`;
        const now = Date.now();

        if (!rateLimitStore[key]) {
            rateLimitStore[key] = { count: 1, resetAt: now + windowMs };
            return next();
        }

        const entry = rateLimitStore[key];

        // Window expired — reset
        if (now > entry.resetAt) {
            entry.count = 1;
            entry.resetAt = now + windowMs;
            return next();
        }

        // Within window
        entry.count++;
        if (entry.count > maxRequests) {
            const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
            res.set('Retry-After', String(retryAfter));
            return res.status(429).json({
                error: "Whoa, slow down! 🦕",
                message: "You're asking questions too fast! Take a breath and try again in a few seconds.",
                retryAfter
            });
        }

        next();
    };
}

// Cleanup expired entries every 5 minutes to prevent memory leaks
setInterval(() => {
    const now = Date.now();
    for (const key of Object.keys(rateLimitStore)) {
        if (now > rateLimitStore[key].resetAt) {
            delete rateLimitStore[key];
        }
    }
}, 5 * 60 * 1000);

// Rate limit configs
const chatLimit = rateLimit(60 * 1000, 10);     // 10 chat requests per minute
const ttsLimit = rateLimit(60 * 1000, 15);       // 15 TTS requests per minute
const visionLimit = rateLimit(60 * 1000, 5);     // 5 vision requests per minute
const authLimit = rateLimit(10 * 1000, 10);      // 10 auth-related requests per 10s

// Initialize Supabase client safely
let supabase;
try {
    const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
    if (process.env.SUPABASE_URL && supaKey) {
        supabase = createClient(
            process.env.SUPABASE_URL,
            supaKey
        );
        console.log("✅ Supabase client initialized");
    } else {
        console.warn("⚠️ Supabase credentials missing (SUPABASE_URL or Key)");
    }
} catch (error) {
    console.error("❌ Supabase initialization failed:", error);
}

// Push Notification Configuration
const publicVapidKey = process.env.VAPID_PUBLIC_KEY;
const privateVapidKey = process.env.VAPID_PRIVATE_KEY;

if (publicVapidKey && privateVapidKey) {
    webpush.setVapidDetails(
        'mailto:adeenamjad714@gmail.com',
        publicVapidKey,
        privateVapidKey
    );
    console.log("✅ Web-Push VAPID keys configured");
} else {
    console.warn("⚠️ Web-Push VAPID keys missing (VAPID_PUBLIC_KEY or VAPID_PRIVATE_KEY)");
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

// --- PUBLIC LEGAL PAGES (Required by Apple App Store & Google Play) ---
app.get('/privacy', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AI Tutor — Privacy Policy</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Inter', -apple-system, sans-serif; background: #f8fafc; color: #334155; line-height: 1.7; }
        .header { background: linear-gradient(135deg, #3b82f6 0%, #6366f1 100%); padding: 56px 24px 72px; text-align: center; color: white; }
        .header h1 { font-size: 36px; font-weight: 800; margin-bottom: 8px; }
        .header p { opacity: 0.85; font-size: 15px; }
        .container { max-width: 740px; margin: -40px auto 60px; padding: 40px 36px; background: white; border-radius: 24px; box-shadow: 0 4px 32px rgba(0,0,0,0.07); position: relative; }
        .badge { display: inline-flex; align-items: center; gap: 8px; background: #ecfdf5; color: #059669; padding: 12px 20px; border-radius: 12px; font-weight: 700; font-size: 14px; margin-bottom: 28px; border: 1px solid #a7f3d0; width: 100%; }
        .dates { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 14px 18px; font-size: 13px; color: #64748b; margin-bottom: 24px; }
        .dates strong { color: #334155; }
        h2 { font-size: 18px; font-weight: 800; color: #0f172a; margin: 36px 0 14px; padding-top: 20px; border-top: 2px solid #f1f5f9; }
        h2:first-of-type { border-top: none; margin-top: 0; padding-top: 0; }
        p { font-size: 15px; margin-bottom: 14px; color: #475569; }
        ul { padding-left: 22px; margin-bottom: 14px; }
        li { font-size: 15px; margin-bottom: 10px; color: #475569; }
        .third-party-table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 14px; }
        .third-party-table th { background: #f8fafc; text-align: left; padding: 10px 14px; font-weight: 700; color: #0f172a; border-bottom: 2px solid #e2e8f0; }
        .third-party-table td { padding: 10px 14px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
        .third-party-table tr:last-child td { border-bottom: none; }
        .third-party-table td:first-child { font-weight: 700; color: #334155; white-space: nowrap; }
        .highlight-box { background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 12px; padding: 16px 18px; margin: 16px 0; }
        .highlight-box strong { color: #1d4ed8; }
        .footer { text-align: center; padding: 28px; color: #94a3b8; font-size: 12px; border-top: 1px solid #f1f5f9; margin-top: 8px; }
        a { color: #3b82f6; text-decoration: none; font-weight: 600; }
        @media (max-width: 640px) { .container { margin: -20px 8px 32px; padding: 28px 20px; } .third-party-table { font-size: 12px; } }
    </style>
</head>
<body>
    <div class="header">
        <h1>🔒 Privacy Policy</h1>
        <p>AI Tutor — Kid-Safe Educational App for Children Ages 4–13</p>
    </div>
    <div class="container">
        <div class="badge">🛡️ STRICT NO DATA SALE POLICY — We never sell, rent, or trade your data. Ever.</div>

        <div class="dates">
            <strong>Effective Date:</strong> April 6, 2026 &nbsp;|&nbsp;
            <strong>Last Updated:</strong> April 6, 2026 &nbsp;|&nbsp;
            <strong>App Version:</strong> 1.0.0
        </div>

        <p>AI Tutor ("we", "our", "us") is committed to protecting the privacy of children and families. This Privacy Policy explains what information we collect, how we use it, who we share it with, and your rights as a parent or guardian.</p>

        <h2>1. Information We Collect</h2>
        <p>We collect only the minimum data necessary to provide the service:</p>
        <ul>
            <li><strong>Parent Email Address:</strong> Used solely for account login and account recovery. We do not send marketing emails without explicit consent.</li>
            <li><strong>Encrypted Password:</strong> Stored as an industry-standard hash (bcrypt). We never see or store your plain text password.</li>
            <li><strong>Child's First Name & Age Range:</strong> Used to personalize lessons and adjust difficulty level. We do not collect the child's full name, date of birth, or school.</li>
            <li><strong>Learning Progress Data:</strong> Coins, XP, quiz scores, lesson history, and inventory items — stored to preserve your child's progress across devices.</li>
            <li><strong>Device & Usage Data:</strong> Crash reports and anonymous usage analytics (e.g., which features are used) to improve the app. This data cannot identify individual users.</li>
        </ul>

        <h2>2. What We Do NOT Collect</h2>
        <ul>
            <li>We do <strong>NOT</strong> store voice recordings. Voice inputs are streamed to our speech-to-text provider for transcription and immediately discarded. We retain no audio.</li>
            <li>We do <strong>NOT</strong> store photos or camera images. Images captured during the Visual Scavenger Hunt are analyzed in real-time and discarded within seconds.</li>
            <li>We do <strong>NOT</strong> collect GPS location, physical address, or precise geolocation data.</li>
            <li>We do <strong>NOT</strong> use advertising SDKs, behavioural tracking, or third-party ad networks.</li>
            <li>We do <strong>NOT</strong> use your child's conversations to train any AI model.</li>
            <li>We do <strong>NOT</strong> collect Social Security numbers, government IDs, or financial information directly.</li>
        </ul>

        <h2>3. Third-Party Services We Use</h2>
        <p>To provide the app's features, we use the following third-party services. Each is listed with what data they handle and a link to their own privacy policy:</p>
        <table class="third-party-table">
            <thead>
                <tr>
                    <th>Service</th>
                    <th>Purpose</th>
                    <th>Data Shared</th>
                    <th>Privacy Policy</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td>Supabase</td>
                    <td>Database & Authentication</td>
                    <td>Email, encrypted password, progress data</td>
                    <td><a href="https://supabase.com/privacy" target="_blank">supabase.com/privacy</a></td>
                </tr>
                <tr>
                    <td>OpenRouter</td>
                    <td>AI lesson generation (Gemini 2.0)</td>
                    <td>Anonymized chat messages (no PII)</td>
                    <td><a href="https://openrouter.ai/privacy" target="_blank">openrouter.ai/privacy</a></td>
                </tr>
                <tr>
                    <td>OpenAI</td>
                    <td>Text-to-speech (AI voices)</td>
                    <td>Text strings only — no personal data</td>
                    <td><a href="https://openai.com/policies/privacy-policy" target="_blank">openai.com/policies</a></td>
                </tr>
                <tr>
                    <td>Deepgram</td>
                    <td>Speech-to-text (voice input)</td>
                    <td>Audio stream — immediately discarded after transcription</td>
                    <td><a href="https://deepgram.com/privacy" target="_blank">deepgram.com/privacy</a></td>
                </tr>
                <tr>
                    <td>RevenueCat</td>
                    <td>In-app purchase management</td>
                    <td>Email (user ID), purchase receipts</td>
                    <td><a href="https://www.revenuecat.com/privacy" target="_blank">revenuecat.com/privacy</a></td>
                </tr>
                <tr>
                    <td>LemonSqueezy</td>
                    <td>Web payment processing</td>
                    <td>Email, payment info (PCI compliant)</td>
                    <td><a href="https://www.lemonsqueezy.com/privacy" target="_blank">lemonsqueezy.com/privacy</a></td>
                </tr>
                <tr>
                    <td>Resend</td>
                    <td>Transactional email (progress reports)</td>
                    <td>Parent email, child's first name</td>
                    <td><a href="https://resend.com/privacy" target="_blank">resend.com/privacy</a></td>
                </tr>
                <tr>
                    <td>Sentry</td>
                    <td>Crash reporting & error monitoring</td>
                    <td>Anonymous crash logs, device type, OS version</td>
                    <td><a href="https://sentry.io/privacy/" target="_blank">sentry.io/privacy</a></td>
                </tr>
                <tr>
                    <td>PostHog</td>
                    <td>Product analytics (feature usage)</td>
                    <td>Anonymous usage events — no PII</td>
                    <td><a href="https://posthog.com/privacy" target="_blank">posthog.com/privacy</a></td>
                </tr>
                <tr>
                    <td>Apple / Google</td>
                    <td>App Store distribution & in-app purchases</td>
                    <td>Subject to Apple/Google privacy policies</td>
                    <td>apple.com/privacy / policies.google.com</td>
                </tr>
            </tbody>
        </table>

        <h2>4. Children's Privacy — COPPA & GDPR-K Compliance</h2>
        <div class="highlight-box">
            <strong>This app is designed for children under 13.</strong> We comply with the Children's Online Privacy Protection Act (COPPA) and the GDPR provisions for children (GDPR-K).
        </div>
        <ul>
            <li>We require verifiable parental consent (via a math-based parental gate) before any account is created or data is collected.</li>
            <li>We do not condition a child's participation on disclosing more personal information than is reasonably necessary to use the service.</li>
            <li>No AI conversation data is used for training. All AI inference is stateless.</li>
            <li>All content responses are filtered through a dual-layer child safety moderation system before being shown to a child.</li>
            <li>We do not allow children to post publicly visible content or interact with other users without parental configuration.</li>
        </ul>

        <h2>5. Data Storage, Security & Retention</h2>
        <ul>
            <li><strong>Storage:</strong> All personal data is stored in Supabase databases hosted on AWS (us-east-1 region), with row-level security enabled.</li>
            <li><strong>Encryption:</strong> All data is encrypted in transit via TLS 1.2+ and encrypted at rest using AES-256.</li>
            <li><strong>Retention:</strong> Account data is retained for as long as the account is active. Deleted accounts are permanently erased within 48 hours.</li>
            <li><strong>Crash logs:</strong> Retained for 90 days then automatically deleted.</li>
        </ul>

        <h2>6. Parental Rights (COPPA / GDPR)</h2>
        <p>As a parent or guardian, you have the right to:</p>
        <ul>
            <li><strong>Access:</strong> Review all data associated with your child's account by emailing us.</li>
            <li><strong>Correct:</strong> Update your child's name, age range, or any account information within the app settings.</li>
            <li><strong>Delete:</strong> Request permanent deletion of your account and all associated data at any time — we respond within 48 hours.</li>
            <li><strong>Withdraw Consent:</strong> Stop all data collection immediately by deleting your account.</li>
            <li><strong>Data Portability:</strong> Request a copy of your account data in machine-readable format.</li>
        </ul>
        <p>To exercise any of these rights, email: <a href="mailto:adeenamjad714@gmail.com">adeenamjad714@gmail.com</a></p>

        <h2>7. Data Transfers</h2>
        <p>AI Tutor is operated by an individual developer. Some of our third-party service providers (listed in Section 3) process data in the United States and other countries outside your region. By using this app, you consent to this international data transfer, which is conducted under appropriate safeguards (Standard Contractual Clauses where applicable).</p>

        <h2>8. Push Notifications</h2>
        <p>If you grant permission, we may send push notifications reminding your child to continue their learning streak. You can disable these at any time in your device's notification settings. We do not send promotional or advertising notifications.</p>

        <h2>9. Changes to This Policy</h2>
        <p>We will notify you of any material changes to this Privacy Policy by updating the "Last Updated" date above and, where appropriate, by sending an email to the registered parent account. Continued use of the app after changes constitutes acceptance of the updated policy.</p>

        <h2>10. Contact Us</h2>
        <p>For privacy concerns, data deletion requests, or any questions about this policy:</p>
        <ul>
            <li><strong>Email:</strong> <a href="mailto:adeenamjad714@gmail.com">adeenamjad714@gmail.com</a></li>
            <li><strong>Support Page:</strong> <a href="/support">ai-tutor-murex.vercel.app/support</a></li>
            <li><strong>Response Time:</strong> We respond to all privacy requests within 48 hours.</li>
        </ul>
    </div>
    <div class="footer">© ${new Date().getFullYear()} AI Tutor. All rights reserved. &nbsp;|&nbsp; <a href="/terms">Terms of Service</a> &nbsp;|&nbsp; <a href="/support">Support</a></div>
</body>
</html>`);
});

app.get('/terms', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AI Tutor — Terms of Service</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Inter', -apple-system, sans-serif; background: #f8fafc; color: #334155; line-height: 1.7; }
        .header { background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); padding: 48px 24px; text-align: center; color: white; }
        .header h1 { font-size: 32px; font-weight: 800; margin-bottom: 8px; }
        .header p { opacity: 0.85; font-size: 14px; }
        .container { max-width: 720px; margin: -32px auto 48px; padding: 40px 32px; background: white; border-radius: 24px; box-shadow: 0 4px 24px rgba(0,0,0,0.06); position: relative; }
        h2 { font-size: 20px; font-weight: 700; color: #0f172a; margin: 32px 0 12px; padding-top: 16px; border-top: 1px solid #f1f5f9; }
        h2:first-of-type { border-top: none; margin-top: 0; padding-top: 0; }
        p, li { font-size: 15px; margin-bottom: 12px; }
        ul { padding-left: 20px; }
        li { margin-bottom: 8px; }
        .footer { text-align: center; padding: 24px; color: #94a3b8; font-size: 12px; }
        a { color: #6366f1; }
        @media (max-width: 640px) { .container { margin: -16px 8px 24px; padding: 24px 20px; } }
    </style>
</head>
<body>
    <div class="header">
        <h1>📋 Terms of Service</h1>
        <p>AI Tutor — Kid-Safe Educational App</p>
    </div>
    <div class="container">
        <p><strong>Effective Date:</strong> March 2026 &nbsp;|&nbsp; <strong>Last Updated:</strong> March 2026</p>

        <h2>1. Acceptance of Terms</h2>
        <p>By accessing or using AI Tutor ("the App"), you agree to be bound by these Terms of Service. This app is intended for educational use by children under the supervision of a parent or legal guardian.</p>

        <h2>2. Parental Responsibility</h2>
        <p>You represent that you are the parent or legal guardian of the child using this app. You are responsible for maintaining the confidentiality of your PIN and for all activity that occurs under your account. You are responsible for supervising your child's use of the App.</p>

        <h2>3. Subscriptions & Payments</h2>
        <ul>
            <li>Premium features are offered on a monthly subscription basis.</li>
            <li>Payment is processed through Apple App Store or Google Play Store using their respective in-app purchase systems.</li>
            <li>Subscriptions automatically renew unless cancelled at least 24 hours before the end of the current period.</li>
            <li>You may cancel at any time through your device's subscription management settings.</li>
            <li>No refunds will be provided for partial billing periods, except as required by applicable law or app store policies.</li>
        </ul>

        <h2>4. Acceptable Use</h2>
        <p>The App is designed for educational purposes. You agree not to:</p>
        <ul>
            <li>Attempt to bypass the AI's content safety filters</li>
            <li>Use the App for any unlawful or harmful purpose</li>
            <li>Reverse engineer, decompile, or attempt to extract the source code</li>
            <li>Share your account credentials with unauthorized parties</li>
        </ul>

        <h2>5. AI-Generated Content</h2>
        <p>The App uses AI to generate educational content, including explanations, quizzes, and stories. While we strive for accuracy, AI-generated content may occasionally contain errors. The App is intended to supplement, not replace, formal education. We are not liable for any inaccuracies in AI-generated content.</p>

        <h2>6. Intellectual Property</h2>
        <p>All content, features, and functionality of the App, including but not limited to text, graphics, logos, and software, are the exclusive property of AI Tutor and are protected by international copyright laws.</p>

        <h2>7. Limitation of Liability</h2>
        <p>The App is provided "as is" without warranties of any kind, either express or implied. In no event shall AI Tutor be liable for any indirect, incidental, special, consequential, or punitive damages, including loss of data or profits.</p>

        <h2>8. Changes to Terms</h2>
        <p>We reserve the right to modify these Terms at any time. Continued use of the App after changes constitutes acceptance of the new Terms. Material changes will be communicated via the App or email.</p>

        <h2>9. Governing Law</h2>
        <p>These Terms shall be governed by and construed in accordance with applicable laws, without regard to conflict of law principles.</p>

        <h2>10. Contact Us</h2>
        <p>For questions about these Terms, contact us at: <a href="mailto:adeenamjad714@gmail.com">adeenamjad714@gmail.com</a></p>
    </div>
    <div class="footer">© ${new Date().getFullYear()} AI Tutor. All rights reserved.</div>
</body>
</html>`);
});

// --- LEGAL PAGE ALIASES (support both /privacy and /privacy.html formats) ---
app.get('/privacy.html', (req, res) => res.redirect(301, '/privacy'));
app.get('/terms.html', (req, res) => res.redirect(301, '/terms'));

// --- SUPPORT PAGE ---
app.get('/support', (req, res) => {
    res.sendFile(path.join(process.cwd(), 'support.html'));
});
app.get('/support.html', (req, res) => res.redirect(301, '/support'));

// --- GDPR: Account Deletion ---
app.post('/api/delete-account', authLimit, async (req, res) => {
    const { userId, email } = req.body;

    if (!userId || !email) {
        return res.status(400).json({ error: 'userId and email are required' });
    }

    if (!supabase) {
        return res.status(503).json({ error: 'Database not available' });
    }

    try {
        // 1. Delete all user data from profiles table
        const { error: profileError } = await supabase
            .from('profiles')
            .delete()
            .eq('email', email);

        if (profileError) {
            console.error('Profile delete error:', profileError);
            // Continue anyway — partial deletion is better than none
        }

        // 2. Delete the auth user (requires service role key)
        const { error: authError } = await supabase.auth.admin.deleteUser(userId);

        if (authError) {
            console.error('Auth delete error:', authError);
            return res.status(500).json({ error: 'Failed to delete account: ' + authError.message });
        }

        console.log(`✅ Account deleted: ${email}`);
        res.json({ success: true, message: 'Account permanently deleted' });

    } catch (err) {
        console.error('Delete account error:', err);
        res.status(500).json({ error: 'Server error during account deletion' });
    }
});


app.get('/api/health', (req, res) => {
    res.json({ status: "ok", version: "voice-debug-v1", time: new Date().toISOString() });
});

// --- DEBUG ENDPOINT ---
app.get('/api/debug', (req, res) => {
    const checkKey = (key) => {
        const val = process.env[key];
        if (!val) return "❌ MISSING";
        if (val.includes('your_') || val.includes('placeholder')) return "⚠️ PLACEHOLDER";
        return "✅ SET";
    };

    res.json({
        environment: process.env.NODE_ENV || 'production',
        keys: {
            OPENROUTER_API_KEY: checkKey('OPENROUTER_API_KEY'),
            OPENAI_API_KEY: checkKey('OPENAI_API_KEY'),
            SUPABASE_URL: checkKey('SUPABASE_URL'),
            SUPABASE_ANON_KEY: checkKey('SUPABASE_ANON_KEY'),
            SUPABASE_SERVICE_ROLE_KEY: checkKey('SUPABASE_SERVICE_ROLE_KEY'),
            DEEPGRAM_API_KEY: checkKey('DEEPGRAM_API_KEY'),
            RESEND_API_KEY: checkKey('RESEND_API_KEY')
        },
        supabaseInitialized: !!supabase,
        timestamp: new Date().toISOString()
    });
});

// --- PUSH NOTIFICATION ROUTES ---

app.get('/api/config/vapid', (req, res) => {
    res.json({ publicKey: publicVapidKey });
});

app.post('/api/save-subscription', async (req, res) => {
    try {
        const { email, subscription } = req.body;
        if (!email) return res.status(400).json({ error: "Missing email" });

        if (!supabase) return res.status(503).json({ error: "Database not available" });

        // Get existing stats
        const { data: profile } = await supabase.from('profiles').select('learning_stats').eq('email', email).single();
        const stats = profile?.learning_stats || {};

        // Update with subscription
        stats.push_subscription = subscription;

        const { error } = await supabase
            .from('profiles')
            .update({ learning_stats: stats })
            .eq('email', email);

        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        console.error("Save subscription error:", err);
        res.status(500).json({ error: err.message });
    }
});

// Vercel Cron endpoint - fires once daily
app.get('/api/cron/daily-reminders', async (req, res) => {
    try {
        const { force, test_email } = req.query; // Added for testing
        
        if (!supabase) throw new Error("Database not initialized");

        const todayString = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

        // Fetch all profiles with subscriptions who haven't used the app today
        const { data: profiles, error } = await supabase
            .from('profiles')
            .select('email, learning_stats');

        if (error) throw error;

        const results = [];
        for (const profile of profiles) {
            const stats = profile.learning_stats || {};
            const sub = stats.push_subscription;
            const lastStreakDate = stats.last_streak_date;

            // Optional: Filter by test email if provided
            if (test_email && profile.email !== test_email) continue;

            // Only notify if they have a subscription AND (force mode OR haven't practiced today)
            if (sub && (force === 'true' || lastStreakDate !== todayString)) {
                const payload = JSON.stringify({
                    title: "Don't break your streak! 🔥",
                    body: "Professor Dino is waiting for you to learn something new today!",
                    url: "/"
                });

                try {
                    await webpush.sendNotification(sub, payload);
                    results.push({ email: profile.email, status: 'sent' });
                } catch (sendErr) {
                    console.error(`Failed to send push to ${profile.email}:`, sendErr.message);
                    results.push({ email: profile.email, status: 'failed', error: sendErr.message });
                }
            }
        }

        res.json({ processed: profiles.length, details: results });
    } catch (err) {
        console.error("Cron failed:", err);
        res.status(500).json({ error: err.message });
    }
});

// Vercel Cron endpoint - fires once weekly (Monday) to reset weekly xp
app.get('/api/cron/reset-weekly-xp', async (req, res) => {
    try {
        if (!supabase) throw new Error("Database not initialized");

        // 1. Fetch the Top 3 learners from the CURRENT week before resetting
        const { data: topLearners, error: fetchError } = await supabase
            .from('weekly_xp')
            .select('user_id, xp_this_week, week_number')
            .gt('xp_this_week', 0)
            .order('xp_this_week', { ascending: false })
            .limit(3);

        if (fetchError) throw fetchError;

        // 2. Distribute coin rewards (1st: 300, 2nd: 200, 3rd: 100)
        if (topLearners && topLearners.length > 0) {
            const rewardAmounts = [300, 200, 100];
            
            for (let i = 0; i < topLearners.length; i++) {
                const learner = topLearners[i];
                const coinsToAward = rewardAmounts[i] || 0;
                
                // Fetch the user's current profile to update coins safely
                const { data: userProfile, error: profileError } = await supabase
                    .from('profiles')
                    .select('learning_stats')
                    .eq('id', learner.user_id)
                    .single();
                    
                if (profileError || !userProfile) continue;
                
                // Safely add coins to learning_stats.inventory.coins (assuming frontend mirrors this)
                // Note: Frontend currently stores coins natively in `this.coins`, but it syncs to `learning_stats`
                let stats = userProfile.learning_stats || {};
                
                // Track historical leaderboard wins in their profile for potential UI popups later
                if (!stats.leaderboard_wins) stats.leaderboard_wins = [];
                stats.leaderboard_wins.push({
                    week_number: learner.week_number,
                    rank: i + 1,
                    reward: coinsToAward,
                    xp: learner.xp_this_week,
                    claimed: false // Frontend can check this to show a celebration popup
                });

                await supabase.from('profiles').update({ learning_stats: stats }).eq('id', learner.user_id);
            }
        }

        // 3. Update all rows in weekly_xp where xp_this_week > 0 to be 0
        const { error: resetError } = await supabase
            .from('weekly_xp')
            .update({ xp_this_week: 0 })
            .gt('xp_this_week', 0);

        if (resetError) throw resetError;

        // 4. ALSO Reset learning_stats.xp_this_week for all user profiles
        // We fetch all profiles with XP this week and reset them to maintain report accuracy
        const { data: profilesToReset, error: fetchResetError } = await supabase
            .from('profiles')
            .select('id, email, learning_stats');

        if (!fetchResetError && profilesToReset) {
            for (const profile of profilesToReset) {
                let stats = profile.learning_stats || {};
                if (typeof stats === 'string') { try { stats = JSON.parse(stats); } catch { stats = {}; } }
                
                if (stats.xp_this_week > 0) {
                    stats.xp_this_week = 0;
                    await supabase.from('profiles').update({ learning_stats: stats }).eq('id', profile.id);
                }
            }
        }

        console.log("✅ Weekly XP reset successful & Rewards Distributed!");
        res.json({ success: true, message: "Weekly XP reset & rewarded successfully." });
    } catch (err) {
        console.error("Weekly XP reset failed:", err);
        res.status(500).json({ error: err.message });
    }
});




// ─────────────────────────────────────────────────────────────────────────────
// WEEKLY PARENT DASHBOARD EMAIL — Cron: every Monday 08:00 UTC
// Also exposes /api/send-weekly-report-now?secret=... for manual testing
// ─────────────────────────────────────────────────────────────────────────────

async function sendWeeklyReportToUser(email, stats) {
    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) return { ok: false, reason: 'RESEND_API_KEY missing' };

    // ── Pull metrics from learning_stats ──────────────────────────────────────
    const childName   = stats.child_name   || 'Your Child';
    const coins       = stats.coins        ?? 0;
    const streak      = stats.streak       ?? 0;
    const xpThisWeek  = stats.xp_this_week ?? stats.weekly_xp ?? 0;
    const totalXP     = stats.total_xp     ?? 0;
    const quizzesDone = stats.quizzes_done ?? stats.quiz_count ?? 0;
    const lessonsCompleted = stats.lessons_completed ?? stats.lesson_count ?? 0;
    const lastQuestion = stats.last_question || 'kept exploring with curiosity!';
    const trialDaysLeft = stats.trial_days_left ?? null;
    const isPremium   = stats.is_premium   ?? false;

    // ── XP Progress bar (max 500 XP per week as reference) ───────────────────
    const xpPercent = Math.min(Math.round((xpThisWeek / 500) * 100), 100);
    const xpBar = `
        <div style="background:#e2e8f0;border-radius:99px;height:10px;margin-top:8px;overflow:hidden;">
            <div style="background:linear-gradient(90deg,#4f46e5,#7c3aed);height:10px;width:${xpPercent}%;border-radius:99px;transition:width 0.5s;"></div>
        </div>
        <div style="text-align:right;font-size:11px;color:#94a3b8;margin-top:4px;">${xpPercent}% of weekly goal</div>
    `;

    // ── Streak badge ─────────────────────────────────────────────────────────
    const streakBadge = streak >= 7
        ? `<span style="background:#fef3c7;color:#92400e;border-radius:99px;padding:4px 12px;font-size:13px;font-weight:700;">🔥 ${streak}-Day Streak — Amazing!</span>`
        : streak >= 3
        ? `<span style="background:#dcfce7;color:#166534;border-radius:99px;padding:4px 12px;font-size:13px;font-weight:700;">🔥 ${streak}-Day Streak — Keep it up!</span>`
        : `<span style="background:#f1f5f9;color:#64748b;border-radius:99px;padding:4px 12px;font-size:13px;font-weight:700;">📅 ${streak} Day${streak !== 1 ? 's' : ''} Active</span>`;

    // ── Trial / Premium notice ────────────────────────────────────────────────
    const accountNotice = isPremium
        ? `<div style="background:#dcfce7;border:1px solid #bbf7d0;border-radius:12px;padding:14px 18px;margin-bottom:24px;color:#166534;font-size:14px;font-weight:600;">✅ Premium Member — Full access active</div>`
        : trialDaysLeft !== null && trialDaysLeft > 0
        ? `<div style="background:#fefce8;border:1px solid #fde68a;border-radius:12px;padding:14px 18px;margin-bottom:24px;color:#78350f;font-size:14px;font-weight:600;">⏳ Free Trial — ${trialDaysLeft} day${trialDaysLeft !== 1 ? 's' : ''} left. <a href="https://ai-tutor-murex.vercel.app" style="color:#4f46e5;font-weight:700;">Upgrade to keep the streak going →</a></div>`
        : `<div style="background:#fee2e2;border:1px solid #fecaca;border-radius:12px;padding:14px 18px;margin-bottom:24px;color:#7f1d1d;font-size:14px;font-weight:600;">⚠️ Trial Expired — <a href="https://ai-tutor-murex.vercel.app" style="color:#4f46e5;font-weight:700;">Upgrade now to keep learning →</a></div>`;

    // ── Stat cards ────────────────────────────────────────────────────────────
    const statCards = [
        { label: 'XP This Week',       value: `⚡ ${xpThisWeek} XP`,   color: '#4f46e5' },
        { label: 'Total XP Earned',    value: `🌟 ${totalXP}`,         color: '#7c3aed' },
        { label: 'Coins',              value: `💰 ${coins}`,           color: '#f59e0b' },
        { label: 'Quizzes Completed',  value: `🏆 ${quizzesDone}`,     color: '#10b981' },
        { label: 'Lessons Done',       value: `📚 ${lessonsCompleted}`, color: '#3b82f6' },
        { label: 'Day Streak',         value: `🔥 ${streak}`,          color: '#ef4444' },
    ].map(c => `
        <div style="background:#fff;border:1px solid #f1f5f9;border-radius:12px;padding:16px;margin-bottom:12px;box-shadow:0 1px 2px rgba(0,0,0,0.05);">
            <div style="color:#64748b;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;">${c.label}</div>
            <div style="color:${c.color};font-size:22px;font-weight:700;margin-top:4px;">${c.value}</div>
        </div>
    `).join('');

    // ── Full email HTML ───────────────────────────────────────────────────────
    const htmlContent = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  @media only screen and (max-width:600px){.container{width:100%!important;border-radius:0!important;}}
</style>
</head>
<body style="margin:0;padding:0;background-color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table width="100%" border="0" cellspacing="0" cellpadding="0">
  <tr>
    <td align="center" style="padding:24px 0;">
      <div class="container" style="max-width:600px;width:95%;background:#fff;border-radius:24px;overflow:hidden;box-shadow:0 10px 15px -3px rgba(0,0,0,0.1);">

        <!-- Header -->
        <div style="background:linear-gradient(135deg,#4f46e5 0%,#7c3aed 100%);padding:48px 32px;text-align:center;">
          <div style="font-size:56px;margin-bottom:12px;">🎓</div>
          <h1 style="color:#fff;margin:0;font-size:26px;font-weight:800;">Weekly Learning Report</h1>
          <p style="color:rgba(255,255,255,0.8);margin:8px 0 0;font-size:15px;">${childName}'s progress · Week of ${new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}</p>
        </div>

        <!-- Body -->
        <div style="padding:32px;">

          ${accountNotice}

          <!-- Streak badge centred -->
          <div style="text-align:center;margin-bottom:28px;">${streakBadge}</div>

          <!-- XP Progress -->
          <div style="background:#f8fafc;border-radius:16px;padding:20px;margin-bottom:28px;">
            <div style="color:#0f172a;font-size:16px;font-weight:700;margin-bottom:4px;">⚡ XP Earned This Week</div>
            <div style="color:#4f46e5;font-size:32px;font-weight:800;">${xpThisWeek} <span style="font-size:16px;font-weight:500;color:#64748b;">XP</span></div>
            ${xpBar}
          </div>

          <!-- Stat cards -->
          <h3 style="color:#0f172a;font-size:18px;font-weight:700;margin-bottom:16px;">📊 Weekly Highlights</h3>
          ${statCards}

          <!-- Last curiosity -->
          <div style="margin-top:28px;">
            <h3 style="color:#0f172a;font-size:18px;font-weight:700;margin-bottom:12px;">📝 What ${childName} Explored</h3>
            <div style="background:#eff6ff;border-radius:16px;padding:20px;">
              <div style="color:#1d4ed8;font-size:15px;font-style:italic;line-height:1.6;">"${lastQuestion}"</div>
            </div>
          </div>

          <!-- CTA -->
          <div style="text-align:center;margin-top:36px;">
            <a href="https://ai-tutor-murex.vercel.app" style="background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;text-decoration:none;padding:16px 40px;border-radius:14px;font-weight:700;font-size:16px;display:inline-block;">Open AI Tutor →</a>
          </div>

          <!-- Footer note -->
          <div style="margin-top:40px;padding-top:24px;border-top:1px solid #f1f5f9;text-align:center;">
            <div style="color:#10b981;font-weight:700;font-size:13px;">✅ VERIFIED BY AI TUTOR</div>
            <p style="color:#64748b;font-size:12px;margin-top:10px;line-height:1.6;">
              This report is sent automatically every Monday. It verifies that ${childName} is actively engaging with lessons, quizzes, and daily goals on AI Tutor.
              <br><br>
              <a href="https://ai-tutor-murex.vercel.app" style="color:#94a3b8;font-size:11px;">Unsubscribe from weekly reports</a>
            </p>
          </div>
        </div>

        <!-- Footer bar -->
        <div style="background:#f1f5f9;padding:24px 32px;text-align:center;">
          <p style="color:#94a3b8;font-size:12px;margin:0;">© ${new Date().getFullYear()} AI Tutor — Dedicated to your child's success.</p>
          <div style="margin-top:8px;color:#cbd5e1;font-size:11px;">Weekly Analytics · Parent Dashboard · Kid-Safe AI</div>
        </div>

      </div>
    </td>
  </tr>
</table>
</body>
</html>`;

    const sendRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${resendKey}`
        },
        body: JSON.stringify({
            from: 'AI Tutor <support@aitutor.app>',
            to:   [email],
            subject: `📊 ${childName}'s Weekly Learning Report — AI Tutor`,
            html: htmlContent
        })
    });

    const result = await sendRes.json();
    return sendRes.ok
        ? { ok: true,  id: result.id }
        : { ok: false, reason: JSON.stringify(result) };
}

// Automated cron — fires every Monday at 08:00 UTC via vercel.json
app.get('/api/cron/weekly-parent-report', async (req, res) => {
    console.log('📧 [Weekly Report] Cron started...');
    try {
        if (!supabase) throw new Error('Supabase not initialized');
        if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY missing');

        const { data: profiles, error } = await supabase
            .from('profiles')
            .select('email, learning_stats');

        if (error) throw error;

        const results = [];
        for (const profile of profiles) {
            if (!profile.email) continue;

            let stats = profile.learning_stats || {};
            if (typeof stats === 'string') {
                try { stats = JSON.parse(stats); } catch { stats = {}; }
            }

            // Skip profiles that have explicitly opted out
            if (stats.weekly_report_opt_out === true) {
                results.push({ email: profile.email, status: 'skipped (opted out)' });
                continue;
            }

            try {
                const outcome = await sendWeeklyReportToUser(profile.email, stats);
                results.push({ email: profile.email, status: outcome.ok ? 'sent' : 'failed', detail: outcome.ok ? outcome.id : outcome.reason });
                console.log(outcome.ok
                    ? `✅ Report sent to ${profile.email}`
                    : `❌ Failed for ${profile.email}: ${outcome.reason}`
                );
            } catch (sendErr) {
                results.push({ email: profile.email, status: 'error', detail: sendErr.message });
            }
        }

        const sent   = results.filter(r => r.status === 'sent').length;
        const failed = results.filter(r => r.status === 'failed' || r.status === 'error').length;
        console.log(`📧 [Weekly Report] Done — ${sent} sent, ${failed} failed, ${profiles.length} total.`);
        res.json({ success: true, sent, failed, total: profiles.length, results });

    } catch (err) {
        console.error('❌ [Weekly Report] Cron error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Manual trigger for testing (protect with a secret query param)
app.get('/api/send-weekly-report-now', async (req, res) => {
    const { secret, email } = req.query;
    if (secret !== process.env.ADMIN_CRON_SECRET) {
        return res.status(403).json({ error: 'Forbidden — provide ?secret=YOUR_ADMIN_CRON_SECRET' });
    }
    try {
        if (!supabase) throw new Error('Supabase not initialized');

        let query = supabase.from('profiles').select('email, learning_stats');
        if (email) query = query.eq('email', email); // Test a single address

        const { data: profiles, error } = await query;
        if (error) throw error;

        const results = [];
        for (const profile of profiles) {
            if (!profile.email) continue;
            let stats = profile.learning_stats || {};
            if (typeof stats === 'string') { try { stats = JSON.parse(stats); } catch { stats = {}; } }
            const outcome = await sendWeeklyReportToUser(profile.email, stats);
            results.push({ email: profile.email, ...outcome });
        }
        res.json({ success: true, results });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Authenticated manual request for a single parent report
app.post('/api/request-parent-report', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    try {
        if (!supabase) throw new Error('Supabase not initialized');

        // Fetch the user's latest stats
        const { data: profile, error } = await supabase
            .from('profiles')
            .select('email, learning_stats')
            .eq('email', email)
            .single();

        if (error || !profile) throw new Error('Profile not found');

        let stats = profile.learning_stats || {};
        if (typeof stats === 'string') { try { stats = JSON.parse(stats); } catch { stats = {}; } }

        const outcome = await sendWeeklyReportToUser(profile.email, stats);
        
        if (outcome.ok) {
            res.json({ success: true, id: outcome.id });
        } else {
            res.status(500).json({ error: outcome.reason });
        }
    } catch (err) {
        console.error("Manual Report Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────


app.post('/api/chat', chatLimit, async (req, res) => {
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
                "HTTP-Referer": "https://ai-tutor-murex.vercel.app", // Updated to match current URL
                "X-Title": "AI Tutor"
            },
            body: JSON.stringify({
                "model": "google/gemini-2.0-flash-001",
                "messages": messages,
                "max_tokens": 2000,
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

app.post('/api/tts', ttsLimit, async (req, res) => {
    try {
        const { text, voiceId } = req.body;
        const vId = voiceId ? voiceId.trim() : "voice_placeholder_id";

        // --- Provider 1: OpenAI TTS (Preferred if Key exists) ---
        const openAiKey = normalizeKey(process.env.OPENAI_API_KEY);
        if (openAiKey && openAiKey !== 'your_openai_key_here') {
            try {
                // Map Voice.ai IDs to OpenAI voices
                // Dino (Deep/Friendly) -> Alloy
                // Monkey (High/Energetic) -> Shimmer
                // Alien (Ethereal) -> Nova
                // Cat (Soft) -> Fable
                // Bee (Playful) -> Onyx (or Shimmer)
                const voiceMap = {
                    "9740af7a-9674-4be1-967b-cf6daba06596": "alloy",   // Professor Dino (Classic/Friendly)
                    "79005bb6-7ae3-4768-b2a0-efc774a3c7a9": "echo",    // Milo Monkey (Energetic/Unique)
                    "0062153d-dd11-4330-a6b1-87cd29187ed7": "nova",    // Starry Alien (Dreamy/Sweet)
                    "2c96d996-4e88-44e8-944a-303d5b063775": "shimmer", // Magic Cat (Soft/Sweet)
                    "a09a1325-058b-4bc7-9105-b96b1cce27c5": "fable"    // Bouncy Bee (Playful/Sweet)
                };
                const openAiVoice = voiceMap[vId] || "shimmer";

                console.log(`🎙️ OpenAI TTS. Voice: ${openAiVoice}`);
                const response = await fetch('https://api.openai.com/v1/audio/speech', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${openAiKey}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        model: "tts-1",
                        input: text,
                        voice: openAiVoice
                    })
                });

                if (response.ok) {
                    const audioBuffer = await response.arrayBuffer();
                    res.set('Content-Type', 'audio/mpeg');
                    return res.send(Buffer.from(audioBuffer));
                }
            } catch (err) {
                console.warn("⚠️ OpenAI TTS Error:", err.message);
            }
        }

        // --- No Providers Available ---
        if (!openAiKey || openAiKey === 'your_openai_key_here') {
            console.error("❌ OpenAI API key is missing or placeholder for TTS.");
        }
        console.error("❌ No TTS providers configured or all failed.");
        res.status(503).json({ error: "No TTS providers available. Please check environment variables (OPENAI_API_KEY)." });

    } catch (error) {
        console.error("❌ TTS Endpoint Exception:", error);
        res.status(500).json({ error: "TTS processing failed", message: error.message });
    }
});

app.post('/api/stt', async (req, res) => {
    try {
        const { audio } = req.body;
        const apiKey = normalizeKey(process.env.DEEPGRAM_API_KEY);

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
app.post('/api/vision', visionLimit, async (req, res) => {
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
app.post('/api/send-email', authLimit, async (req, res) => {
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
                from: 'AI Tutor <support@aitutor.app>',
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

// --- SPACED REPETITION ENGINE (SRM) CRON JOB ---
app.get('/api/cron/srm-review', async (req, res) => {
    try {
        console.log("⏰ Running Daily Spaced Repetition Cron Job...");
        
        if (!supabase) {
            return res.status(500).json({ error: "Supabase not configured." });
        }

        // 1. Fetch all profiles
        const { data: profiles, error: fetchError } = await supabase
            .from('profiles')
            .select('email, learning_stats');

        if (fetchError) {
            console.error("❌ Failed to fetch profiles for SRM:", fetchError);
            return res.status(500).json({ error: "DB fetch error" });
        }

        const now = Date.now();
        let updatedCount = 0;

        // 2. Process each profile
        for (const profile of profiles) {
            let stats = profile.learning_stats;
            if (!stats) continue;

            // Handle stringified JSON
            if (typeof stats === 'string') {
                try { stats = JSON.parse(stats); } 
                catch (e) { continue; }
            }

            // Check if they have mastery levels to review
            if (stats.mastery_levels && Object.keys(stats.mastery_levels).length > 0) {
                let hasUpdates = false;
                
                // Initialize review queue if missing
                if (!stats.review_queue) stats.review_queue = [];
                
                // 3. Check every tracked word
                for (const [conceptKey, data] of Object.entries(stats.mastery_levels)) {
                    if (data.next_review && data.next_review <= now) {
                        // Time to review! Check if it's already in the queue
                        const alreadyInQueue = stats.review_queue.some(q => q.question === data.question_data.question);
                        
                        if (!alreadyInQueue) {
                            stats.review_queue.push({
                                ...data.question_data,
                                conceptKey: conceptKey, // Track which word this is for reporting back
                                timestamp: now
                            });
                            hasUpdates = true;
                        }
                    }
                }

                // 4. Update DB if they have newly queued reviews
                if (hasUpdates) {
                    const { error: updateError } = await supabase
                        .from('profiles')
                        .update({ learning_stats: stats })
                        .eq('email', profile.email);
                        
                    if (updateError) {
                        console.error(`❌ Failed to update SRM for ${profile.email}:`, updateError);
                    } else {
                        console.log(`✅ Queued reviews for ${profile.email}`);
                        updatedCount++;
                    }
                }
            }
        }

        res.json({ success: true, message: `SRM Cron Completed. Updated ${updatedCount} profiles.` });

    } catch (e) {
        console.error("❌ Internal Spaced Repetition Error:", e);
        res.status(500).json({ error: e.message });
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
                            redirect_url: (req.get('origin') || `${req.protocol}://${req.get('host')}`) + '/?payment=success'
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
            // Calculate expiry date (30 days from now)
            const expiryDate = new Date();
            expiryDate.setDate(expiryDate.getDate() + 30);
            
            const { error } = await supabase
                .from('profiles')
                .update({ 
                    is_premium: true,
                    premium_expiry: expiryDate.getTime()
                })
                .eq('email', userEmail);

            if (error) {
                console.error('Error updating Supabase:', error);
                return res.status(500).send('Database update failed');
            }
            console.log(`Successfully upgraded user ${userEmail} to premium until ${expiryDate.toISOString()}`);
        }

        res.status(200).send('OK');
    } catch (error) {
        console.error('Webhook Error:', error);
        res.status(500).send('Internal Server Error');
    }
});

// --- REVENUECAT WEBHOOK (Mobile In-App Purchases) ---
// Set the shared secret in Vercel as: REVENUECAT_WEBHOOK_SECRET
// Then in RevenueCat dashboard: Project → Integrations → Webhooks → add your URL:
//   https://ai-tutor-murex.vercel.app/api/revenuecat-webhook
app.post('/api/revenuecat-webhook', async (req, res) => {
    try {
        const secret = process.env.REVENUECAT_WEBHOOK_SECRET;
        if (!secret) {
            console.error('⚠️ REVENUECAT_WEBHOOK_SECRET missing — accepting all (insecure)');
        } else {
            const authHeader = req.headers['authorization'];
            if (authHeader !== secret) {
                console.error('❌ RevenueCat webhook: Invalid authorization');
                return res.status(401).json({ error: 'Invalid authorization' });
            }
        }

        const { event } = req.body;
        if (!event) return res.status(400).json({ error: 'Missing event' });

        const eventType = event.type;
        const userEmail = event.app_user_id; // We set this to the user's email via Purchases.logIn()
        
        console.log(`📱 RevenueCat Webhook: ${eventType} for ${userEmail}`);

        if (!supabase || !userEmail) {
            return res.status(200).json({ received: true, note: 'No action taken — DB or email missing' });
        }

        // Grant premium on purchase / renewal / reactivation
        if (['INITIAL_PURCHASE', 'RENEWAL', 'PRODUCT_CHANGE', 'UNCANCELLATION'].includes(eventType)) {
            const expiresAt = event.expiration_at_ms || (Date.now() + 30 * 24 * 60 * 60 * 1000);
            const { error } = await supabase
                .from('profiles')
                .update({
                    is_premium: true,
                    premium_expiry: expiresAt
                })
                .eq('email', userEmail);

            if (error) {
                console.error('RevenueCat: DB update error:', error);
                return res.status(500).json({ error: 'DB update failed' });
            }
            console.log(`✅ RevenueCat: Premium granted to ${userEmail} until ${new Date(expiresAt).toISOString()}`);
        }

        // Revoke premium on cancellation / expiration / billing issue
        if (['CANCELLATION', 'EXPIRATION', 'BILLING_ISSUE'].includes(eventType)) {
            const { error } = await supabase
                .from('profiles')
                .update({ is_premium: false })
                .eq('email', userEmail);

            if (error) {
                console.error('RevenueCat: DB revoke error:', error);
            } else {
                console.log(`📵 RevenueCat: Premium revoked for ${userEmail}`);
            }
        }

        res.status(200).json({ received: true });
    } catch (error) {
        console.error('RevenueCat Webhook Error:', error);
        res.status(500).send('Internal Server Error');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ AI Tutor Server is running on port ${PORT}`);
});

module.exports = app;
