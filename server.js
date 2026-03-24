require('dotenv').config();

const crypto      = require('crypto');
const cookieParser= require('cookie-parser');
const express     = require('express');
const cors       = require('cors');
const multer     = require('multer');
const { Resend } = require('resend');

const app    = express();
const resend = new Resend(process.env.RESEND_API_KEY);

// Accepted image MIME types + extensions (HEIC has no standard MIME on some devices)
const ACCEPTED_MIME = ['image/jpeg','image/png','image/gif','image/webp','image/bmp',
                       'image/heic','image/heif','image/avif','image/tiff'];
const ACCEPTED_EXT  = ['jpg','jpeg','png','gif','webp','bmp','heic','heif','avif','tiff','tif'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024, files: 6 },
  fileFilter: (_req, file, cb) => {
    const mime = (file.mimetype || '').toLowerCase();
    const ext  = (file.originalname || '').split('.').pop().toLowerCase();
    // Accept: known image MIME, known image extension, generic binary (Android camera),
    // empty MIME (HEIC on iOS), or .bin extension (Android camera output)
    const accept = mime.startsWith('image/')
      || ACCEPTED_MIME.includes(mime)
      || ACCEPTED_EXT.includes(ext)
      || mime === 'application/octet-stream'
      || mime === ''
      || ext  === 'bin'
      || ext  === '';
    cb(null, accept);
  },
});

const PORT = process.env.PORT || 3000;

const TRADE_LABELS = {
  plumb: 'Plumbing',  elec: 'Electrical', carp: 'Carpentry',
  plast: 'Drywall',   roof: 'Roofing',    paint: 'Painting',
  hvac:  'HVAC',      other: 'General / Other',
};

const allowedOrigins = [
  process.env.FRONTEND_URL,       // e.g. https://home101.vercel.app
  'http://localhost:8080',
  'http://127.0.0.1:8080',
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, Postman, same-origin)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('CORS blocked: ' + origin));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));

// Handle preflight OPTIONS requests
app.options('*', cors());
app.use(cookieParser());
app.use(express.json());

// ── POST /api/request ──────────────────────────────────────────────────────────
// Wrap multer so file errors return JSON instead of crashing the function
function uploadMiddleware(req, res, next) {
  upload.array('photos', 6)(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'One or more photos exceeds the 10 MB limit.' });
      }
      return res.status(400).json({ error: 'File upload error: ' + err.message });
    }
    if (err) return res.status(400).json({ error: 'Could not process uploaded files.' });
    next();
  });
}

app.post('/api/request', uploadMiddleware, async (req, res) => {
  const { trade, description, address, firstName, lastName, phone, email, notes } = req.body;
  const turnstileToken = req.body['cf-turnstile-response'];

  // Validate required fields
  if (!trade || !description || !address || !firstName || !lastName || !phone || !email) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  // Verify Cloudflare Turnstile token
  if (!turnstileToken) {
    return res.status(400).json({ error: 'Please complete the CAPTCHA.' });
  }
  try {
    const verify = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret:   process.env.TURNSTILE_SECRET_KEY,
        response: turnstileToken,
      }),
    });
    const result = await verify.json();
    if (!result.success) {
      return res.status(400).json({ error: 'CAPTCHA verification failed. Please try again.' });
    }
  } catch (err) {
    console.error('Turnstile error:', err);
    return res.status(400).json({ error: 'Could not verify CAPTCHA. Please try again.' });
  }

  // Build and send email
  const reference  = 'H1-' + Math.floor(10000 + Math.random() * 90000);

  // Build "Create Quote" deep-link — pre-fills the invoice tool with this customer's details
  const invoiceBase = process.env.INVOICE_TOOL_URL || 'file:///home101-invoice.html';
  const quoteParams = new URLSearchParams({
    name:      `${firstName} ${lastName}`,
    email:     email,
    phone:     phone,
    address:   address,
    ref:       reference,
    job:       `${TRADE_LABELS[trade] || trade} — ${description}`,
  });
  const quoteLink = `${invoiceBase}?${quoteParams.toString()}`;
  const tradeLabel = TRADE_LABELS[trade] || trade;
  const submittedAt = new Date().toLocaleString('en-CA', {
    timeZone: 'America/Edmonton', dateStyle: 'full', timeStyle: 'short',
  });

  const photosNote = (req.files || []).length > 0
    ? `<p style="margin:0 0 8px;font-size:13px;color:#888;font-weight:600;">${req.files.length} photo(s) attached.</p>`
    : `<p style="color:#aaa;font-size:13px;">No photos uploaded.</p>`;

  const notesBlock = notes ? `
    <p style="margin:0 0 8px;font-size:11px;color:#aaa;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;">Additional Notes</p>
    <div style="background:#f7f4ef;border-radius:10px;padding:14px 18px;margin-bottom:24px;">
      <p style="margin:0;font-size:14px;color:#555;line-height:1.6;">${notes.replace(/\n/g,"<br>")}</p>
    </div>` : "";

  const htmlBody = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f1ec;font-family:Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1ec;padding:40px 20px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
  <tr><td style="background:#1c1c1c;padding:28px 36px;">
    <span style="font-size:22px;font-weight:900;color:#fff;font-style:italic;">Home 101</span>
    <span style="display:block;color:rgba(255,255,255,0.4);font-size:12px;margin-top:4px;">New Service Request — ${submittedAt}</span>
  </td></tr>
  <tr><td style="background:#c8922a;padding:14px 36px;">
    <span style="color:#fff;font-size:14px;font-weight:700;letter-spacing:0.06em;">REF: ${reference}</span>
    <span style="float:right;background:rgba(255,255,255,0.2);color:#fff;padding:3px 12px;border-radius:50px;font-size:12px;font-weight:600;">${tradeLabel}</span>
  </td></tr>
  <tr><td style="padding:32px 36px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f7f4ef;border-radius:12px;padding:20px;margin-bottom:24px;">
      <tr><td style="padding:6px 16px;">
        <p style="margin:0;font-size:11px;color:#aaa;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;">Customer</p>
        <p style="margin:4px 0 0;font-size:18px;font-weight:700;color:#1c1c1c;">${firstName} ${lastName}</p>
      </td></tr>
      <tr><td style="padding:0 16px;"><hr style="border:none;border-top:1px solid rgba(0,0,0,0.07);margin:12px 0;"></td></tr>
      <tr><td style="padding:4px 16px;">
        <p style="font-size:13px;color:#555;margin:4px 0;"><a href="tel:${phone}" style="color:#c8922a;text-decoration:none;font-weight:600;">${phone}</a></p>
        <p style="font-size:13px;color:#555;margin:4px 0;"><a href="mailto:${email}" style="color:#c8922a;text-decoration:none;font-weight:600;">${email}</a></p>
        <p style="font-size:13px;color:#555;margin:4px 0;"><strong>${address}</strong></p>
      </td></tr>
    </table>
    <p style="margin:0 0 8px;font-size:11px;color:#aaa;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;">Problem Description</p>
    <div style="background:#f7f4ef;border-left:4px solid #c8922a;border-radius:0 10px 10px 0;padding:16px 20px;margin-bottom:24px;">
      <p style="margin:0;font-size:15px;color:#333;line-height:1.7;">${description.replace(/\n/g,"<br>")}</p>
    </div>
    ${notesBlock}
    <p style="margin:0 0 10px;font-size:11px;color:#aaa;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;">Photos</p>
    ${photosNote}
  </td></tr>
  <!-- Create Quote button -->
  <tr><td style="padding:24px 36px 28px;text-align:center;border-top:1px solid rgba(0,0,0,0.06);">
    <p style="margin:0 0 14px;font-size:12px;color:#aaa;">Ready to send a quote for this request?</p>
    <a href="${quoteLink}" style="display:inline-block;background:#c8922a;color:#fff;text-decoration:none;padding:13px 36px;border-radius:8px;font-size:14px;font-weight:700;letter-spacing:0.01em;">Create Quote for ${firstName}</a>
  </td></tr>
  <tr><td style="background:#f7f4ef;padding:16px 36px;border-top:1px solid rgba(0,0,0,0.06);">
    <p style="margin:0;font-size:12px;color:#aaa;line-height:1.6;">Submitted via the Home 101 website. Reply to this email to respond directly to the customer.</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

  const textBody = [
    `NEW REQUEST [${reference}] — ${tradeLabel}`,
    `Submitted: ${submittedAt}`,
    `Customer:  ${firstName} ${lastName}`,
    `Phone:     ${phone}`,
    `Email:     ${email}`,
    `Address:   ${address}`,
    `Problem:   ${description}`,
    notes ? `Notes: ${notes}` : null,
    `Photos: ${(req.files||[]).length} attached`,
  ].filter(Boolean).join("\n");

  const attachments = (req.files || []).map((f, i) => ({
    filename:    `photo-${i+1}-${f.originalname}`,
    content:     f.buffer.toString('base64'),
    contentType: f.mimetype,
  }));

  try {
    await resend.emails.send({
      from:        process.env.EMAIL_FROM,
      to:          process.env.EMAIL_TO,
      replyTo:     email,
      subject:     `[${reference}] New ${tradeLabel} Request — ${firstName} ${lastName}`,
      html:        htmlBody,
      text:        textBody,
      attachments,
    });
    return res.status(201).json({ success: true, reference });
  } catch (err) {
    console.error('Email error:', err);
    return res.status(500).json({ error: 'Failed to send request. Please try again.' });
  }
});


// ── POST /api/invoice — Send a branded quote/invoice email ────────────────────
// Body (JSON): { customerName, customerEmail, customerPhone, address,
//               jobDescription, lineItems: [{label, amount}],
//               stripePaymentLink, dueDate, notes, reference }
app.post('/api/invoice', express.json(), requireSession, async (req, res) => {
  const {
    customerName, customerEmail, customerPhone, address,
    jobDescription, lineItems = [], stripePaymentLink,
    dueDate, notes, reference,
  } = req.body;

  if (!customerName || !customerEmail || !stripePaymentLink) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  const invoiceRef = reference || ('INV-' + Math.floor(10000 + Math.random() * 90000));
  const total = lineItems.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const fmt = (n) => '$' + Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const issuedAt = new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/Edmonton', year: 'numeric', month: 'long', day: 'numeric',
  });

  const lineItemsHtml = lineItems.map(item => `
    <tr>
      <td style="padding:10px 0;font-size:14px;color:#333;border-bottom:1px solid rgba(0,0,0,0.06);">${item.label}</td>
      <td style="padding:10px 0;font-size:14px;color:#333;text-align:right;border-bottom:1px solid rgba(0,0,0,0.06);white-space:nowrap;">${fmt(item.amount)}</td>
    </tr>`).join('');

  const notesBlock = notes ? `
    <p style="margin:0 0 8px;font-size:11px;color:#aaa;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;">Notes</p>
    <div style="background:#f7f4ef;border-radius:10px;padding:14px 18px;margin-bottom:24px;">
      <p style="margin:0;font-size:14px;color:#555;line-height:1.6;">${notes.replace(/\n/g,'<br>')}</p>
    </div>` : '';

  const dueDateBlock = dueDate
    ? `<p style="margin:4px 0;font-size:13px;color:#555;">Due by <strong>${dueDate}</strong></p>`
    : '';

  const htmlBody = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f1ec;font-family:Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1ec;padding:40px 20px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

  <!-- Header -->
  <tr><td style="background:#1c1c1c;padding:28px 36px;">
    <span style="font-size:22px;font-weight:900;color:#fff;font-style:italic;">Home 101</span>
    <span style="display:block;color:rgba(255,255,255,0.4);font-size:12px;margin-top:4px;">Quote &amp; Payment — Issued ${issuedAt}</span>
  </td></tr>

  <!-- Gold bar with ref + badge -->
  <tr><td style="background:#c8922a;padding:14px 36px;">
    <span style="color:#fff;font-size:14px;font-weight:700;letter-spacing:0.06em;">REF: ${invoiceRef}</span>
    <span style="float:right;background:rgba(255,255,255,0.2);color:#fff;padding:3px 12px;border-radius:50px;font-size:12px;font-weight:600;">Quote</span>
  </td></tr>

  <!-- Body -->
  <tr><td style="padding:32px 36px;">

    <!-- Customer card -->
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f7f4ef;border-radius:12px;padding:20px;margin-bottom:28px;">
      <tr><td style="padding:6px 16px;">
        <p style="margin:0;font-size:11px;color:#aaa;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;">Prepared for</p>
        <p style="margin:4px 0 0;font-size:18px;font-weight:700;color:#1c1c1c;">${customerName}</p>
      </td></tr>
      <tr><td style="padding:0 16px;"><hr style="border:none;border-top:1px solid rgba(0,0,0,0.07);margin:12px 0;"></td></tr>
      <tr><td style="padding:4px 16px;">
        ${customerPhone ? `<p style="font-size:13px;color:#555;margin:4px 0;"><a href="tel:${customerPhone}" style="color:#c8922a;text-decoration:none;font-weight:600;">${customerPhone}</a></p>` : ''}
        <p style="font-size:13px;color:#555;margin:4px 0;"><a href="mailto:${customerEmail}" style="color:#c8922a;text-decoration:none;font-weight:600;">${customerEmail}</a></p>
        ${address ? `<p style="font-size:13px;color:#555;margin:4px 0;"><strong>${address}</strong></p>` : ''}
      </td></tr>
    </table>

    <!-- Job description -->
    <p style="margin:0 0 8px;font-size:11px;color:#aaa;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;">Work Description</p>
    <div style="background:#f7f4ef;border-left:4px solid #c8922a;border-radius:0 10px 10px 0;padding:16px 20px;margin-bottom:28px;">
      <p style="margin:0;font-size:15px;color:#333;line-height:1.7;">${jobDescription.replace(/\n/g,'<br>')}</p>
    </div>

    <!-- Line items -->
    <p style="margin:0 0 12px;font-size:11px;color:#aaa;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;">Quote Breakdown</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
      ${lineItemsHtml}
      <tr>
        <td style="padding:14px 0 4px;font-size:15px;font-weight:700;color:#1c1c1c;">Total</td>
        <td style="padding:14px 0 4px;font-size:20px;font-weight:900;color:#c8922a;text-align:right;white-space:nowrap;">${fmt(total)}</td>
      </tr>
    </table>
    ${dueDateBlock}

    ${notesBlock}

    <!-- Pay button -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:28px;">
      <tr><td align="center">
        <a href="${stripePaymentLink}" style="display:inline-block;background:#1c1c1c;color:#fff;text-decoration:none;padding:16px 48px;border-radius:10px;font-size:16px;font-weight:700;letter-spacing:0.01em;">Pay Now — ${fmt(total)}</a>
      </td></tr>
      <tr><td align="center" style="padding-top:12px;">
        <p style="margin:0;font-size:12px;color:#aaa;">Secure payment powered by Stripe</p>
      </td></tr>
    </table>

  </td></tr>

  <!-- Footer -->
  <tr><td style="background:#f7f4ef;padding:20px 36px;border-top:1px solid rgba(0,0,0,0.06);">
    <p style="margin:0;font-size:12px;color:#aaa;line-height:1.6;">
      Questions about this quote? Reply to this email or call us directly.<br>
      Home 101 — Calgary, AB
    </p>
  </td></tr>

</table>
</td></tr></table>
</body></html>`;

  const textBody = [
    `QUOTE [${invoiceRef}] — Home 101`,
    `Issued: ${issuedAt}`,
    `To: ${customerName} <${customerEmail}>`,
    address ? `Address: ${address}` : null,
    ``,
    `Work: ${jobDescription}`,
    ``,
    ...lineItems.map(i => `  ${i.label}: ${fmt(i.amount)}`),
    `  ────────────`,
    `  Total: ${fmt(total)}`,
    dueDate ? `Due: ${dueDate}` : null,
    ``,
    notes ? `Notes: ${notes}` : null,
    ``,
    `Pay here: ${stripePaymentLink}`,
  ].filter(s => s !== null).join('\n');

  try {
    await resend.emails.send({
      from:    process.env.EMAIL_FROM,
      to:      customerEmail,
      replyTo: process.env.EMAIL_TO,
      subject: `Your Quote from Home 101 — ${fmt(total)} [${invoiceRef}]`,
      html:    htmlBody,
      text:    textBody,
    });
    return res.status(201).json({ success: true, reference: invoiceRef });
  } catch (err) {
    console.error('Invoice email error:', err);
    return res.status(500).json({ error: 'Failed to send invoice. Please try again.' });
  }
});


// ── AUTH & INVOICE TOOL — Served directly from backend ───────────────────────
// The invoice HTML is never a public file. It is only sent by this server
// after verifying a signed HttpOnly cookie that the browser cannot manipulate.

const COOKIE_NAME   = 'h101_sess';
const COOKIE_SECRET = process.env.TURNSTILE_SECRET_KEY || 'fallback-secret';
const SESSION_TTL   = 8 * 60 * 60 * 1000; // 8 hours

function makeSessionCookie() {
  const payload = JSON.stringify({ exp: Date.now() + SESSION_TTL });
  const sig     = crypto.createHmac('sha256', COOKIE_SECRET).update(payload).digest('hex');
  return Buffer.from(payload + '.' + sig).toString('base64url');
}

function verifySessionCookie(raw) {
  try {
    const decoded  = Buffer.from(raw, 'base64url').toString('utf8');
    const dotIdx   = decoded.lastIndexOf('.');
    const payload  = decoded.slice(0, dotIdx);
    const sig      = decoded.slice(dotIdx + 1);
    const expected = crypto.createHmac('sha256', COOKIE_SECRET).update(payload).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
    const { exp } = JSON.parse(payload);
    return Date.now() < exp;
  } catch { return false; }
}

function requireSession(req, res, next) {
  if (verifySessionCookie(req.cookies[COOKIE_NAME] || '')) return next();
  res.status(401).json({ error: 'Session expired — please log in again.' });
}

// ── GET /invoice — serve login page (never the invoice tool itself) ───────────
app.get('/invoice', (req, res) => {
  if (verifySessionCookie(req.cookies[COOKIE_NAME] || '')) {
    return res.redirect('/invoice/app');
  }
  const showError = req.query.error === '1';
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Home 101 — Login</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;background:#f7f4ef;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.card{background:#fff;border-radius:20px;padding:40px;box-shadow:0 8px 40px rgba(28,28,28,0.12);border:1px solid rgba(28,28,28,0.1);width:100%;max-width:360px;text-align:center}
.logo{font-size:1.5rem;font-weight:900;font-style:italic;margin-bottom:6px;color:#1c1c1c}
.logo span{color:#c8922a}
.sub{font-size:0.82rem;color:#888;margin-bottom:24px}
input[type=password]{width:100%;border:1.5px solid rgba(28,28,28,0.1);border-radius:10px;padding:12px 14px;font-size:0.95rem;background:#f7f4ef;outline:none;text-align:center;letter-spacing:0.15em;margin-bottom:12px;transition:border-color .2s,box-shadow .2s;display:block}
input[type=password]:focus{border-color:#c8922a;box-shadow:0 0 0 3px rgba(200,146,42,0.12);background:#fff}
button{width:100%;background:#1c1c1c;color:#fff;border:none;border-radius:10px;padding:13px;font-size:0.95rem;font-weight:700;cursor:pointer;transition:background .2s}
button:hover{background:#c8922a}
.err{font-size:0.82rem;color:#b83232;margin-top:10px;padding:9px 12px;background:rgba(184,50,50,0.07);border-radius:8px;${showError ? '' : 'display:none'}}
</style>
</head>
<body>
<div class="card">
  <div class="logo">Home<span> 101</span></div>
  <p class="sub">Internal tool — staff access only</p>
  <form method="POST" action="/api/auth">
    <input type="password" name="password" placeholder="Password" autofocus required />
    <button type="submit">Unlock</button>
  </form>
  <p class="err">${showError ? 'Incorrect password — please try again.' : ''}</p>
</div>
</body>
</html>`);
});

// ── POST /api/auth — verify password, set HttpOnly cookie ─────────────────────
app.post('/api/auth', express.urlencoded({ extended: false }), async (req, res) => {
  const password = (req.body && req.body.password) ? String(req.body.password) : '';
  const expected = process.env.INVOICE_PASSWORD;

  if (!expected) {
    return res.redirect('/invoice?error=1');
  }
  // Support both bcrypt-style hashes (starts with $scrypt$) and plaintext fallback
  let match = false;
  try {
    if (expected.startsWith('$scrypt$')) {
      // Stored as a scrypt hash — most secure, uses Node built-in crypto only
      const [, , saltHex, hashHex] = expected.split('$');
      const salt = Buffer.from(saltHex, 'hex');
      const storedHash = Buffer.from(hashHex, 'hex');
      const derivedKey = await new Promise((resolve, reject) =>
        crypto.scrypt(password, salt, 64, (err, key) => err ? reject(err) : resolve(key))
      );
      match = password.length > 0 && crypto.timingSafeEqual(derivedKey, storedHash);
    } else {
      // Plaintext fallback — constant-time compare
      if (password.length === expected.length) {
        const a = Buffer.alloc(256); const b = Buffer.alloc(256);
        Buffer.from(password).copy(a); Buffer.from(expected).copy(b);
        match = password.length > 0 && crypto.timingSafeEqual(a, b);
      }
    }
  } catch (e) {
    console.error('Auth comparison error:', e);
  }

  if (!match) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }

  // Set a signed HttpOnly cookie — JS cannot read or modify this
  res.cookie(COOKIE_NAME, makeSessionCookie(), {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',   // 'lax' works better than 'strict' on Vercel redirects
    maxAge:   SESSION_TTL,
    path:     '/',
  });
  return res.json({ ok: true });
});

// ── GET /invoice/app — serve the invoice tool (authenticated only) ────────────
app.get('/invoice/app', (req, res) => {
  if (!verifySessionCookie(req.cookies[COOKIE_NAME] || '')) {
    return res.redirect('/invoice');
  }
  res.setHeader('Content-Type', 'text/html');
  // Cache-Control: no-store ensures the page is never cached by the browser
  res.setHeader('Cache-Control', 'no-store');
  res.send(getInvoiceAppHtml());
});

// ── POST /api/logout — clear the session cookie ───────────────────────────────
app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});


// ── Invoice app HTML — only served to authenticated users ─────────────────────
function getInvoiceAppHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Home 101 — Send Quote</title>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,700;0,900&family=Instrument+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg: #f7f4ef; --ink: #1c1c1c; --slate: #3a3a3a;
  --gold: #c8922a; --muted: #888; --line: rgba(28,28,28,0.1);
  --white: #ffffff; --stone: #f0ece4; --success: #2a7a52; --error: #b83232;
}
body { font-family: 'Instrument Sans', sans-serif; background: var(--bg); color: var(--ink); min-height: 100vh; padding: 40px 20px; }
.page { max-width: 720px; margin: 0 auto; }

/* PASSWORD */
#lockScreen { position: fixed; inset: 0; background: var(--bg); display: flex; align-items: center; justify-content: center; z-index: 999; }
.lock-card { background: var(--white); border-radius: 20px; padding: 40px; box-shadow: 0 8px 40px rgba(28,28,28,0.12); border: 1px solid var(--line); width: 100%; max-width: 360px; text-align: center; }
.lock-logo { font-family: 'Fraunces', serif; font-size: 1.5rem; font-weight: 900; font-style: italic; margin-bottom: 6px; }
.lock-logo span { color: var(--gold); }
.lock-sub { font-size: 0.82rem; color: var(--muted); margin-bottom: 24px; }
.lock-card input { width: 100%; border: 1.5px solid var(--line); border-radius: 10px; padding: 12px 14px; font-size: 0.95rem; font-family: 'Instrument Sans', sans-serif; background: var(--bg); outline: none; text-align: center; letter-spacing: 0.15em; margin-bottom: 12px; transition: border-color .2s, box-shadow .2s; }
.lock-card input:focus { border-color: var(--gold); box-shadow: 0 0 0 3px rgba(200,146,42,0.12); background: var(--white); }
.lock-btn { width: 100%; background: var(--ink); color: var(--white); border: none; border-radius: 10px; padding: 13px; font-family: 'Instrument Sans', sans-serif; font-size: 0.95rem; font-weight: 700; cursor: pointer; transition: background .2s; }
.lock-btn:hover { background: var(--gold); }
.lock-error { font-size: 0.8rem; color: var(--error); margin-top: 8px; display: none; }

#mainContent { display: none; }

/* HEADER */
.page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; flex-wrap: wrap; gap: 10px; }
.logo { font-family: 'Fraunces', serif; font-size: 1.4rem; font-weight: 900; font-style: italic; color: var(--ink); }
.logo span { color: var(--gold); }
.badge { background: var(--stone); border-radius: 50px; padding: 5px 14px; font-size: 0.72rem; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; }
.prefill-banner { background: rgba(200,146,42,0.1); border: 1px solid rgba(200,146,42,0.3); border-radius: 10px; padding: 12px 18px; margin-bottom: 20px; font-size: 0.83rem; color: var(--slate); display: none; }
.prefill-banner strong { color: var(--gold); }

/* CARD */
.card { background: var(--white); border-radius: 20px; padding: 32px; border: 1px solid var(--line); box-shadow: 0 4px 20px rgba(28,28,28,0.06); margin-bottom: 16px; }
.card-title { font-family: 'Fraunces', serif; font-size: 1.1rem; font-weight: 900; margin-bottom: 18px; padding-bottom: 14px; border-bottom: 1px solid var(--line); display: flex; align-items: center; gap: 8px; }
.card-title svg { color: var(--gold); }

/* FIELDS */
.field { margin-bottom: 14px; }
.field label { display: block; font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--slate); margin-bottom: 6px; }
.field input, .field textarea { width: 100%; border: 1.5px solid var(--line); border-radius: 10px; padding: 11px 14px; font-family: 'Instrument Sans', sans-serif; font-size: 0.92rem; color: var(--ink); background: var(--bg); outline: none; transition: border-color .2s, box-shadow .2s; }
.field input:focus, .field textarea:focus { border-color: var(--gold); box-shadow: 0 0 0 3px rgba(200,146,42,0.12); background: var(--white); }
.field textarea { resize: vertical; min-height: 80px; line-height: 1.6; }
.field-row { display: flex; gap: 12px; }
.field-row .field { flex: 1; }
.field-hint { font-size: 0.73rem; color: var(--muted); margin-top: 5px; line-height: 1.5; }

/* LINE ITEMS */
.line-item { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
.line-item input:first-child { flex: 1; }
.line-item input.amt { width: 110px; flex-shrink: 0; }
.line-item-remove { width: 28px; height: 28px; border-radius: 50%; background: var(--stone); border: none; cursor: pointer; font-size: 0.75rem; color: var(--muted); display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: all .2s; }
.line-item-remove:hover { background: rgba(184,50,50,0.12); color: var(--error); }
.add-line-btn { background: transparent; border: 1.5px dashed var(--line); border-radius: 8px; padding: 8px 16px; font-family: 'Instrument Sans', sans-serif; font-size: 0.82rem; color: var(--muted); cursor: pointer; width: 100%; transition: all .2s; margin-top: 4px; }
.add-line-btn:hover { border-color: var(--gold); color: var(--gold); }
.total-row { display: flex; justify-content: space-between; align-items: center; padding: 14px 0 4px; border-top: 2px solid var(--ink); margin-top: 10px; }
.total-row span:first-child { font-weight: 700; }
.total-amount { font-family: 'Fraunces', serif; font-size: 1.6rem; font-weight: 900; color: var(--gold); }

/* STRIPE HELPER */
.stripe-helper { background: rgba(99,91,255,0.05); border: 1px solid rgba(99,91,255,0.15); border-radius: 12px; padding: 16px 18px; margin-bottom: 14px; }
.stripe-helper-title { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #6356ff; margin-bottom: 10px; }
.stripe-steps { font-size: 0.82rem; color: var(--slate); line-height: 1.9; margin-bottom: 12px; }
.stripe-steps strong { color: var(--ink); }
.stripe-amt { display: inline-block; background: rgba(99,91,255,0.1); border-radius: 6px; padding: 1px 9px; font-weight: 700; color: #6356ff; font-size: 0.82rem; }
.stripe-open-btn { display: inline-flex; align-items: center; gap: 7px; background: #6356ff; color: white; border: none; border-radius: 8px; padding: 9px 18px; font-family: 'Instrument Sans', sans-serif; font-size: 0.82rem; font-weight: 700; cursor: pointer; text-decoration: none; transition: background .2s; }
.stripe-open-btn:hover { background: #4f43e0; }

/* BUTTONS */
.action-row { display: flex; gap: 10px; margin-top: 20px; flex-wrap: wrap; }
.btn-primary { flex: 2; min-width: 200px; background: var(--ink); color: var(--white); border: none; border-radius: 10px; padding: 14px; font-family: 'Instrument Sans', sans-serif; font-size: 0.95rem; font-weight: 700; cursor: pointer; transition: background .2s; display: flex; align-items: center; justify-content: center; gap: 8px; }
.btn-primary:hover { background: var(--gold); }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-secondary { flex: 1; min-width: 140px; background: transparent; color: var(--ink); border: 1.5px solid var(--line); border-radius: 10px; padding: 14px; font-family: 'Instrument Sans', sans-serif; font-size: 0.9rem; font-weight: 600; cursor: pointer; transition: all .2s; display: flex; align-items: center; justify-content: center; gap: 7px; }
.btn-secondary:hover { border-color: var(--ink); background: var(--stone); }
.spinner { width: 16px; height: 16px; border: 2.5px solid rgba(255,255,255,0.3); border-top-color: white; border-radius: 50%; animation: spin .7s linear infinite; display: none; }
@keyframes spin { to { transform: rotate(360deg); } }
.status-msg { border-radius: 10px; padding: 13px 18px; font-size: 0.85rem; font-weight: 600; margin-top: 12px; display: none; line-height: 1.5; }
.status-msg.success { background: rgba(42,122,82,0.08); border: 1px solid rgba(42,122,82,0.25); color: var(--success); }
.status-msg.error { background: rgba(184,50,50,0.07); border: 1px solid rgba(184,50,50,0.2); color: var(--error); }

/* PREVIEW */
.preview-label { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin-bottom: 10px; margin-top: 8px; }
.preview-card { background: var(--white); border-radius: 14px; overflow: hidden; border: 1px solid var(--line); font-size: 13px; box-shadow: 0 4px 20px rgba(28,28,28,0.06); }
.p-header { background: var(--ink); padding: 16px 22px; }
.p-logo { font-weight: 900; color: white; font-style: italic; font-size: 16px; }
.p-sub { color: rgba(255,255,255,0.4); font-size: 11px; margin-top: 3px; }
.p-bar { background: var(--gold); padding: 10px 22px; display: flex; justify-content: space-between; align-items: center; }
.p-bar span { color: white; font-weight: 700; font-size: 12px; }
.p-body { padding: 20px 22px; }
.p-meta { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 14px; }
.p-meta-item { font-size: 11px; }
.p-meta-label { color: var(--muted); font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; display: block; margin-bottom: 2px; font-size: 10px; }
.p-meta-val { color: var(--ink); font-weight: 600; }
.p-desc { background: var(--stone); border-left: 3px solid var(--gold); padding: 10px 14px; border-radius: 0 8px 8px 0; font-size: 12px; color: var(--slate); margin-bottom: 14px; line-height: 1.65; white-space: pre-wrap; word-break: break-word; }
.p-lines { width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 10px; }
.p-lines td { padding: 6px 0; border-bottom: 1px solid var(--line); color: var(--slate); }
.p-lines td:last-child { text-align: right; font-weight: 600; white-space: nowrap; }
.p-total-row { display: flex; justify-content: space-between; align-items: center; padding: 10px 0 14px; }
.p-total-label { font-weight: 700; font-size: 13px; }
.p-total-amt { font-family: 'Fraunces', serif; font-size: 1.3rem; font-weight: 900; color: var(--gold); }
.p-pay-btn { display: block; background: var(--ink); color: white; text-align: center; padding: 11px; border-radius: 8px; font-weight: 700; font-size: 13px; text-decoration: none; margin-bottom: 4px; }
.p-notes { background: var(--stone); border-radius: 8px; padding: 10px 14px; font-size: 11px; color: var(--muted); line-height: 1.6; margin-top: 10px; display: none; white-space: pre-wrap; }
.p-due-line { font-size: 11px; color: var(--muted); text-align: center; margin-top: 6px; display: none; }

@media(max-width:600px) { .field-row { flex-direction: column; gap: 0; } .card { padding: 22px; } .action-row { flex-direction: column; } .btn-primary, .btn-secondary { flex: none; width: 100%; } }
</style>
</head>
<body>

    <p class="lock-sub">Internal tool — enter password to continue</p>
    <input type="password" id="passwordInput" placeholder="Password" onkeydown="if(event.key==='Enter')checkPassword()" autofocus />
    <button class="lock-btn" onclick="checkPassword()">Unlock</button>
    <p class="lock-error" id="lockError">Incorrect password — please try again.</p>
  </div>
</div>

<div id="mainContent">
<div class="page">

  <div class="page-header">
    <div class="logo">Home<span> 101</span></div>
    <span class="badge">Internal — Send Quote</span>
    <button onclick="logout()" style="background:transparent;border:1.5px solid var(--line);border-radius:8px;padding:6px 14px;font-family:'Instrument Sans',sans-serif;font-size:0.78rem;font-weight:600;color:var(--muted);cursor:pointer;" onmouseover="this.style.color='var(--ink)'" onmouseout="this.style.color='var(--muted)'">Log out</button>
  </div>
  <div class="prefill-banner" id="prefillBanner"></div>

  <div class="card">
    <div class="card-title">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
      Customer Details
    </div>
    <div class="field-row">
      <div class="field"><label>Full Name</label><input type="text" id="customerName" placeholder="Jane Smith" oninput="updatePreview()" /></div>
      <div class="field"><label>Phone</label><input type="tel" id="customerPhone" placeholder="(403) 555-0192" oninput="updatePreview()" /></div>
    </div>
    <div class="field"><label>Email Address</label><input type="email" id="customerEmail" placeholder="jane@example.com" oninput="updatePreview()" /></div>
    <div class="field"><label>Service Address</label><input type="text" id="address" placeholder="42 Maple Street, Calgary, AB" oninput="updatePreview()" /></div>
  </div>

  <div class="card">
    <div class="card-title">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
      Job Details
    </div>
    <div class="field"><label>Work Description</label><textarea id="jobDescription" placeholder="e.g. Replace kitchen tap and repair corroded pipe under sink. Labour and materials included." oninput="updatePreview()"></textarea></div>
    <div class="field">
      <label>Quote Breakdown</label>
      <div id="lineItems"></div>
      <button class="add-line-btn" onclick="addLineItem()">+ Add line item</button>
      <div class="total-row"><span>Total (CAD)</span><span class="total-amount" id="totalDisplay">$0.00</span></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Due Date <span style="font-weight:400;text-transform:none;">(optional)</span></label><input type="text" id="dueDate" placeholder="e.g. April 5, 2026" oninput="updatePreview()" /></div>
      <div class="field"><label>Reference # <span style="font-weight:400;text-transform:none;">(optional)</span></label><input type="text" id="reference" placeholder="Auto-generated if blank" oninput="updatePreview()" /></div>
    </div>
    <div class="field"><label>Notes <span style="font-weight:400;text-transform:none;">(optional)</span></label><textarea id="notes" rows="2" placeholder="e.g. Price valid for 14 days. Excludes damage found during repair." oninput="updatePreview()"></textarea></div>
  </div>

  <div class="card">
    <div class="card-title">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
      Payment
    </div>
    <div class="stripe-helper">
      <div class="stripe-helper-title">Quick Stripe Payment Link</div>
      <div class="stripe-steps">
        1. Click <strong>Open Stripe</strong> below — goes to your Payment Links dashboard<br>
        2. Click <strong>Create link</strong>, set amount to <span class="stripe-amt" id="stripeAmountHint">$0.00</span> and add a description<br>
        3. Copy the link (starts with <code style="background:rgba(0,0,0,0.06);padding:1px 5px;border-radius:4px;">buy.stripe.com/...</code>) and paste below
      </div>
      <a href="https://dashboard.stripe.com/payment-links" target="_blank" class="stripe-open-btn">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        Open Stripe Dashboard
      </a>
    </div>
    <div class="field">
      <label>Stripe Payment Link</label>
      <input type="url" id="stripePaymentLink" placeholder="https://buy.stripe.com/xxxxxxxx" oninput="updatePreview()" />
      <p class="field-hint">Paste the link generated from Stripe above.</p>
    </div>
  </div>

  <p class="preview-label">Live Email Preview</p>
  <div class="preview-card">
    <div class="p-header">
      <div class="p-logo">Home 101</div>
      <div class="p-sub">Quote &amp; Payment — <span id="p-date"></span></div>
    </div>
    <div class="p-bar">
      <span id="p-ref">REF: —</span>
      <span>Quote</span>
    </div>
    <div class="p-body">
      <div class="p-meta">
        <div class="p-meta-item"><span class="p-meta-label">To</span><span class="p-meta-val" id="p-name">—</span></div>
        <div class="p-meta-item"><span class="p-meta-label">Email</span><span class="p-meta-val" id="p-email">—</span></div>
        <div class="p-meta-item"><span class="p-meta-label">Phone</span><span class="p-meta-val" id="p-phone">—</span></div>
        <div class="p-meta-item"><span class="p-meta-label">Address</span><span class="p-meta-val" id="p-addr">—</span></div>
        <div class="p-meta-item" id="p-due-wrap" style="display:none;"><span class="p-meta-label">Due</span><span class="p-meta-val" id="p-due">—</span></div>
        <div class="p-meta-item"><span class="p-meta-label">Ref</span><span class="p-meta-val" id="p-ref-inline">—</span></div>
      </div>
      <div class="p-desc" id="p-desc">Work description will appear here…</div>
      <table class="p-lines" id="p-lines"><tr><td colspan="2" style="color:var(--muted);font-size:11px;padding:6px 0;">No line items yet</td></tr></table>
      <div class="p-total-row"><span class="p-total-label">Total (CAD)</span><span class="p-total-amt" id="p-total">$0.00</span></div>
      <a class="p-pay-btn" id="p-paybtn" href="#">Pay Now — $0.00</a>
      <p class="p-due-line" id="p-due-line"></p>
      <div class="p-notes" id="p-notes-box"></div>
    </div>
  </div>

  <div class="action-row">
    <button class="btn-primary" id="sendBtn" onclick="sendInvoice()">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
      <span id="sendText">Send Quote to Customer</span>
      <div class="spinner" id="sendSpinner"></div>
    </button>
    <button class="btn-secondary" onclick="downloadPDF()">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      Download PDF
    </button>
  </div>
  <div class="status-msg" id="statusMsg"></div>

</div>
</div>

<script>
const BACKEND_URL = ''; // empty = same origin (backend serves this page)

</script>
</body>
</html>`;
}



// ── GET /api/hash-password — one-time tool to generate a scrypt hash ──────────
// Usage: visit /api/hash-password?p=YourPassword in your browser
// Copy the output into your INVOICE_PASSWORD environment variable on Vercel
// Then delete this route (or leave it — it only generates hashes, never reveals the password)
app.get('/api/hash-password', async (req, res) => {
  const p = req.query.p;
  if (!p) return res.status(400).send('Usage: /api/hash-password?p=yourpassword');
  const salt = crypto.randomBytes(32);
  const hash = await new Promise((resolve, reject) =>
    crypto.scrypt(p, salt, 64, (err, key) => err ? reject(err) : resolve(key))
  );
  const stored = `$scrypt$$${salt.toString('hex')}$${hash.toString('hex')}`;
  res.setHeader('Content-Type', 'text/html');
  res.send(`
    <style>body{font-family:monospace;padding:30px;background:#f7f4ef}
    .box{background:#fff;border-radius:12px;padding:24px;max-width:700px;border:1px solid #ddd}
    h2{color:#1c1c1c;margin-bottom:12px}code{background:#f0ece4;padding:10px;display:block;
    border-radius:8px;word-break:break-all;font-size:13px;margin:12px 0}
    p{color:#555;font-size:14px;line-height:1.6}</style>
    <div class="box">
      <h2>Home 101 — Password Hash</h2>
      <p>Copy this entire value into your <strong>INVOICE_PASSWORD</strong> environment variable on Vercel:</p>
      <code>${stored}</code>
      <p>After updating the env var, redeploy Vercel and your hashed password will be active.<br>
      You can then delete this route from server.js if you wish.</p>
    </div>
  `);
});

app.get('/health', (_, res) => res.json({ status: 'ok' }));

// Listen locally in dev; export for Vercel serverless in production
if (require.main === module) {
  app.listen(PORT, () => console.log(`Home 101 API running on http://localhost:${PORT}`));
}
module.exports = app;
