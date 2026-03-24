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
  process.env.FRONTEND_URL,       // frontend site e.g. https://home101.vercel.app
  process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : null, // backend's own domain
  'http://localhost:8080',
  'http://localhost:3000',
  'http://127.0.0.1:8080',
  'http://127.0.0.1:3000',
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Always allow same-origin requests (no Origin header) and known origins
    if (!origin) return callback(null, true);
    if (allowedOrigins.some(o => o && origin.startsWith(o.replace(/\/+$/, '')))) {
      return callback(null, true);
    }
    // Also allow any vercel.app subdomain (covers preview deployments)
    if (origin.endsWith('.vercel.app')) return callback(null, true);
    callback(new Error('CORS blocked: ' + origin));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
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
  const err = req.query.error === '1';
  res.setHeader('Content-Type', 'text/html');
  res.send('<!DOCTYPE html><html lang="en"><head>'
    + '<meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1.0">'
    + '<title>Home 101 — Login</title>'
    + '<style>'
    + '*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}'
    + 'body{font-family:Helvetica,Arial,sans-serif;background:#f7f4ef;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}'
    + '.card{background:#fff;border-radius:20px;padding:40px;box-shadow:0 8px 40px rgba(28,28,28,0.12);border:1px solid rgba(28,28,28,0.1);width:100%;max-width:360px;text-align:center}'
    + '.logo{font-size:1.5rem;font-weight:900;font-style:italic;margin-bottom:6px;color:#1c1c1c}'
    + '.logo span{color:#c8922a}'
    + '.sub{font-size:0.82rem;color:#888;margin-bottom:24px}'
    + 'input{width:100%;border:1.5px solid rgba(28,28,28,0.1);border-radius:10px;padding:12px 14px;font-size:0.95rem;background:#f7f4ef;outline:none;text-align:center;letter-spacing:0.12em;margin-bottom:12px;display:block}'
    + 'input:focus{border-color:#c8922a;outline:none}'
    + 'button{width:100%;background:#1c1c1c;color:#fff;border:none;border-radius:10px;padding:13px;font-size:0.95rem;font-weight:700;cursor:pointer}'
    + 'button:hover{background:#c8922a}'
    + '.err{font-size:0.82rem;color:#b83232;margin-top:10px;padding:8px;background:rgba(184,50,50,0.07);border-radius:6px}'
    + '</style></head><body>'
    + '<div class="card">'
    + '<div class="logo">Home<span> 101</span></div>'
    + '<p class="sub">Internal tool — staff access only</p>'
    + '<form method="POST" action="/api/auth">'
    + '<input type="password" name="password" placeholder="Password" autofocus required />'
    + '<button type="submit">Unlock</button>'
    + '</form>'
    + (err ? '<p class="err">Incorrect password — please try again.</p>' : '')
    + '</div></body></html>');
});


// ── POST /api/auth ─────────────────────────────────────────────────────────────
app.post('/api/auth', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const password = req.body && req.body.password ? String(req.body.password) : '';
    const expected = process.env.INVOICE_PASSWORD || '';

    if (!expected) {
      console.error('INVOICE_PASSWORD env var not set');
      return res.redirect('/invoice?error=1');
    }

    // If INVOICE_PASSWORD starts with $scrypt$ it's a hash — verify by hashing input
    // Otherwise fall back to plain-text constant-time compare
    const verifyPassword = (pw, stored) => new Promise((resolve) => {
      if (stored.startsWith('$scrypt$')) {
        const parts = stored.split('$');
        const salt  = Buffer.from(parts[2], 'hex');
        const storedHash = Buffer.from(parts[3], 'hex');
        crypto.scrypt(pw, salt, 64, (err, derived) => {
          if (err) return resolve(false);
          resolve(pw.length > 0 && crypto.timingSafeEqual(derived, storedHash));
        });
      } else {
        // Plain text compare
        if (pw.length === 0 || pw.length !== stored.length) return resolve(false);
        const a = Buffer.alloc(256); const b = Buffer.alloc(256);
        Buffer.from(pw).copy(a); Buffer.from(stored).copy(b);
        resolve(crypto.timingSafeEqual(a, b));
      }
    });

    const match = await verifyPassword(password, expected);
    if (!match) {
      return res.redirect('/invoice?error=1');
    }

    res.cookie(COOKIE_NAME, makeSessionCookie(), {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge:   SESSION_TTL,
      path:     '/',
    });
    return res.redirect('/invoice/app');

  } catch (err) {
    console.error('/api/auth error:', err);
    return res.redirect('/invoice?error=1');
  }
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
const INVOICE_HTML_B64 = 'PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9ImVuIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9IlVURi04Ij4KPG1ldGEgbmFtZT0idmlld3BvcnQiIGNvbnRlbnQ9IndpZHRoPWRldmljZS13aWR0aCwgaW5pdGlhbC1zY2FsZT0xLjAiPgo8dGl0bGU+SG9tZSAxMDEg4oCUIFNlbmQgUXVvdGU8L3RpdGxlPgo8bGluayBocmVmPSJodHRwczovL2ZvbnRzLmdvb2dsZWFwaXMuY29tL2NzczI/ZmFtaWx5PUZyYXVuY2VzOml0YWwsd2dodEAwLDcwMDswLDkwMCZmYW1pbHk9SW5zdHJ1bWVudCtTYW5zOndnaHRANDAwOzUwMDs2MDAmZGlzcGxheT1zd2FwIiByZWw9InN0eWxlc2hlZXQiPgo8c2NyaXB0IHNyYz0iaHR0cHM6Ly9jZG5qcy5jbG91ZGZsYXJlLmNvbS9hamF4L2xpYnMvanNwZGYvMi41LjEvanNwZGYudW1kLm1pbi5qcyI+PC9zY3JpcHQ+CjxzdHlsZT4KKiwgKjo6YmVmb3JlLCAqOjphZnRlciB7IGJveC1zaXppbmc6IGJvcmRlci1ib3g7IG1hcmdpbjogMDsgcGFkZGluZzogMDsgfQo6cm9vdCB7CiAgLS1iZzogI2Y3ZjRlZjsgLS1pbms6ICMxYzFjMWM7IC0tc2xhdGU6ICMzYTNhM2E7CiAgLS1nb2xkOiAjYzg5MjJhOyAtLW11dGVkOiAjODg4OyAtLWxpbmU6IHJnYmEoMjgsMjgsMjgsMC4xKTsKICAtLXdoaXRlOiAjZmZmZmZmOyAtLXN0b25lOiAjZjBlY2U0OyAtLXN1Y2Nlc3M6ICMyYTdhNTI7IC0tZXJyb3I6ICNiODMyMzI7Cn0KYm9keSB7IGZvbnQtZmFtaWx5OiAnSW5zdHJ1bWVudCBTYW5zJywgc2Fucy1zZXJpZjsgYmFja2dyb3VuZDogdmFyKC0tYmcpOyBjb2xvcjogdmFyKC0taW5rKTsgbWluLWhlaWdodDogMTAwdmg7IHBhZGRpbmc6IDQwcHggMjBweDsgfQoucGFnZSB7IG1heC13aWR0aDogNzIwcHg7IG1hcmdpbjogMCBhdXRvOyB9CgovKiBQQVNTV09SRCAqLwojbG9ja1NjcmVlbiB7IHBvc2l0aW9uOiBmaXhlZDsgaW5zZXQ6IDA7IGJhY2tncm91bmQ6IHZhcigtLWJnKTsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsganVzdGlmeS1jb250ZW50OiBjZW50ZXI7IHotaW5kZXg6IDk5OTsgfQoubG9jay1jYXJkIHsgYmFja2dyb3VuZDogdmFyKC0td2hpdGUpOyBib3JkZXItcmFkaXVzOiAyMHB4OyBwYWRkaW5nOiA0MHB4OyBib3gtc2hhZG93OiAwIDhweCA0MHB4IHJnYmEoMjgsMjgsMjgsMC4xMik7IGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWxpbmUpOyB3aWR0aDogMTAwJTsgbWF4LXdpZHRoOiAzNjBweDsgdGV4dC1hbGlnbjogY2VudGVyOyB9Ci5sb2NrLWxvZ28geyBmb250LWZhbWlseTogJ0ZyYXVuY2VzJywgc2VyaWY7IGZvbnQtc2l6ZTogMS41cmVtOyBmb250LXdlaWdodDogOTAwOyBmb250LXN0eWxlOiBpdGFsaWM7IG1hcmdpbi1ib3R0b206IDZweDsgfQoubG9jay1sb2dvIHNwYW4geyBjb2xvcjogdmFyKC0tZ29sZCk7IH0KLmxvY2stc3ViIHsgZm9udC1zaXplOiAwLjgycmVtOyBjb2xvcjogdmFyKC0tbXV0ZWQpOyBtYXJnaW4tYm90dG9tOiAyNHB4OyB9Ci5sb2NrLWNhcmQgaW5wdXQgeyB3aWR0aDogMTAwJTsgYm9yZGVyOiAxLjVweCBzb2xpZCB2YXIoLS1saW5lKTsgYm9yZGVyLXJhZGl1czogMTBweDsgcGFkZGluZzogMTJweCAxNHB4OyBmb250LXNpemU6IDAuOTVyZW07IGZvbnQtZmFtaWx5OiAnSW5zdHJ1bWVudCBTYW5zJywgc2Fucy1zZXJpZjsgYmFja2dyb3VuZDogdmFyKC0tYmcpOyBvdXRsaW5lOiBub25lOyB0ZXh0LWFsaWduOiBjZW50ZXI7IGxldHRlci1zcGFjaW5nOiAwLjE1ZW07IG1hcmdpbi1ib3R0b206IDEycHg7IHRyYW5zaXRpb246IGJvcmRlci1jb2xvciAuMnMsIGJveC1zaGFkb3cgLjJzOyB9Ci5sb2NrLWNhcmQgaW5wdXQ6Zm9jdXMgeyBib3JkZXItY29sb3I6IHZhcigtLWdvbGQpOyBib3gtc2hhZG93OiAwIDAgMCAzcHggcmdiYSgyMDAsMTQ2LDQyLDAuMTIpOyBiYWNrZ3JvdW5kOiB2YXIoLS13aGl0ZSk7IH0KLmxvY2stYnRuIHsgd2lkdGg6IDEwMCU7IGJhY2tncm91bmQ6IHZhcigtLWluayk7IGNvbG9yOiB2YXIoLS13aGl0ZSk7IGJvcmRlcjogbm9uZTsgYm9yZGVyLXJhZGl1czogMTBweDsgcGFkZGluZzogMTNweDsgZm9udC1mYW1pbHk6ICdJbnN0cnVtZW50IFNhbnMnLCBzYW5zLXNlcmlmOyBmb250LXNpemU6IDAuOTVyZW07IGZvbnQtd2VpZ2h0OiA3MDA7IGN1cnNvcjogcG9pbnRlcjsgdHJhbnNpdGlvbjogYmFja2dyb3VuZCAuMnM7IH0KLmxvY2stYnRuOmhvdmVyIHsgYmFja2dyb3VuZDogdmFyKC0tZ29sZCk7IH0KLmxvY2stZXJyb3IgeyBmb250LXNpemU6IDAuOHJlbTsgY29sb3I6IHZhcigtLWVycm9yKTsgbWFyZ2luLXRvcDogOHB4OyBkaXNwbGF5OiBub25lOyB9CgojbWFpbkNvbnRlbnQgeyBkaXNwbGF5OiBub25lOyB9CgovKiBIRUFERVIgKi8KLnBhZ2UtaGVhZGVyIHsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsganVzdGlmeS1jb250ZW50OiBzcGFjZS1iZXR3ZWVuOyBtYXJnaW4tYm90dG9tOiAyNHB4OyBmbGV4LXdyYXA6IHdyYXA7IGdhcDogMTBweDsgfQoubG9nbyB7IGZvbnQtZmFtaWx5OiAnRnJhdW5jZXMnLCBzZXJpZjsgZm9udC1zaXplOiAxLjRyZW07IGZvbnQtd2VpZ2h0OiA5MDA7IGZvbnQtc3R5bGU6IGl0YWxpYzsgY29sb3I6IHZhcigtLWluayk7IH0KLmxvZ28gc3BhbiB7IGNvbG9yOiB2YXIoLS1nb2xkKTsgfQouYmFkZ2UgeyBiYWNrZ3JvdW5kOiB2YXIoLS1zdG9uZSk7IGJvcmRlci1yYWRpdXM6IDUwcHg7IHBhZGRpbmc6IDVweCAxNHB4OyBmb250LXNpemU6IDAuNzJyZW07IGZvbnQtd2VpZ2h0OiA3MDA7IGNvbG9yOiB2YXIoLS1tdXRlZCk7IHRleHQtdHJhbnNmb3JtOiB1cHBlcmNhc2U7IGxldHRlci1zcGFjaW5nOiAwLjA4ZW07IH0KLnByZWZpbGwtYmFubmVyIHsgYmFja2dyb3VuZDogcmdiYSgyMDAsMTQ2LDQyLDAuMSk7IGJvcmRlcjogMXB4IHNvbGlkIHJnYmEoMjAwLDE0Niw0MiwwLjMpOyBib3JkZXItcmFkaXVzOiAxMHB4OyBwYWRkaW5nOiAxMnB4IDE4cHg7IG1hcmdpbi1ib3R0b206IDIwcHg7IGZvbnQtc2l6ZTogMC44M3JlbTsgY29sb3I6IHZhcigtLXNsYXRlKTsgZGlzcGxheTogbm9uZTsgfQoucHJlZmlsbC1iYW5uZXIgc3Ryb25nIHsgY29sb3I6IHZhcigtLWdvbGQpOyB9CgovKiBDQVJEICovCi5jYXJkIHsgYmFja2dyb3VuZDogdmFyKC0td2hpdGUpOyBib3JkZXItcmFkaXVzOiAyMHB4OyBwYWRkaW5nOiAzMnB4OyBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1saW5lKTsgYm94LXNoYWRvdzogMCA0cHggMjBweCByZ2JhKDI4LDI4LDI4LDAuMDYpOyBtYXJnaW4tYm90dG9tOiAxNnB4OyB9Ci5jYXJkLXRpdGxlIHsgZm9udC1mYW1pbHk6ICdGcmF1bmNlcycsIHNlcmlmOyBmb250LXNpemU6IDEuMXJlbTsgZm9udC13ZWlnaHQ6IDkwMDsgbWFyZ2luLWJvdHRvbTogMThweDsgcGFkZGluZy1ib3R0b206IDE0cHg7IGJvcmRlci1ib3R0b206IDFweCBzb2xpZCB2YXIoLS1saW5lKTsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiA4cHg7IH0KLmNhcmQtdGl0bGUgc3ZnIHsgY29sb3I6IHZhcigtLWdvbGQpOyB9CgovKiBGSUVMRFMgKi8KLmZpZWxkIHsgbWFyZ2luLWJvdHRvbTogMTRweDsgfQouZmllbGQgbGFiZWwgeyBkaXNwbGF5OiBibG9jazsgZm9udC1zaXplOiAwLjcycmVtOyBmb250LXdlaWdodDogNzAwOyB0ZXh0LXRyYW5zZm9ybTogdXBwZXJjYXNlOyBsZXR0ZXItc3BhY2luZzogMC4wOGVtOyBjb2xvcjogdmFyKC0tc2xhdGUpOyBtYXJnaW4tYm90dG9tOiA2cHg7IH0KLmZpZWxkIGlucHV0LCAuZmllbGQgdGV4dGFyZWEgeyB3aWR0aDogMTAwJTsgYm9yZGVyOiAxLjVweCBzb2xpZCB2YXIoLS1saW5lKTsgYm9yZGVyLXJhZGl1czogMTBweDsgcGFkZGluZzogMTFweCAxNHB4OyBmb250LWZhbWlseTogJ0luc3RydW1lbnQgU2FucycsIHNhbnMtc2VyaWY7IGZvbnQtc2l6ZTogMC45MnJlbTsgY29sb3I6IHZhcigtLWluayk7IGJhY2tncm91bmQ6IHZhcigtLWJnKTsgb3V0bGluZTogbm9uZTsgdHJhbnNpdGlvbjogYm9yZGVyLWNvbG9yIC4ycywgYm94LXNoYWRvdyAuMnM7IH0KLmZpZWxkIGlucHV0OmZvY3VzLCAuZmllbGQgdGV4dGFyZWE6Zm9jdXMgeyBib3JkZXItY29sb3I6IHZhcigtLWdvbGQpOyBib3gtc2hhZG93OiAwIDAgMCAzcHggcmdiYSgyMDAsMTQ2LDQyLDAuMTIpOyBiYWNrZ3JvdW5kOiB2YXIoLS13aGl0ZSk7IH0KLmZpZWxkIHRleHRhcmVhIHsgcmVzaXplOiB2ZXJ0aWNhbDsgbWluLWhlaWdodDogODBweDsgbGluZS1oZWlnaHQ6IDEuNjsgfQouZmllbGQtcm93IHsgZGlzcGxheTogZmxleDsgZ2FwOiAxMnB4OyB9Ci5maWVsZC1yb3cgLmZpZWxkIHsgZmxleDogMTsgfQouZmllbGQtaGludCB7IGZvbnQtc2l6ZTogMC43M3JlbTsgY29sb3I6IHZhcigtLW11dGVkKTsgbWFyZ2luLXRvcDogNXB4OyBsaW5lLWhlaWdodDogMS41OyB9CgovKiBMSU5FIElURU1TICovCi5saW5lLWl0ZW0geyBkaXNwbGF5OiBmbGV4OyBnYXA6IDhweDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgbWFyZ2luLWJvdHRvbTogOHB4OyB9Ci5saW5lLWl0ZW0gaW5wdXQ6Zmlyc3QtY2hpbGQgeyBmbGV4OiAxOyB9Ci5saW5lLWl0ZW0gaW5wdXQuYW10IHsgd2lkdGg6IDExMHB4OyBmbGV4LXNocmluazogMDsgfQoubGluZS1pdGVtLXJlbW92ZSB7IHdpZHRoOiAyOHB4OyBoZWlnaHQ6IDI4cHg7IGJvcmRlci1yYWRpdXM6IDUwJTsgYmFja2dyb3VuZDogdmFyKC0tc3RvbmUpOyBib3JkZXI6IG5vbmU7IGN1cnNvcjogcG9pbnRlcjsgZm9udC1zaXplOiAwLjc1cmVtOyBjb2xvcjogdmFyKC0tbXV0ZWQpOyBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBqdXN0aWZ5LWNvbnRlbnQ6IGNlbnRlcjsgZmxleC1zaHJpbms6IDA7IHRyYW5zaXRpb246IGFsbCAuMnM7IH0KLmxpbmUtaXRlbS1yZW1vdmU6aG92ZXIgeyBiYWNrZ3JvdW5kOiByZ2JhKDE4NCw1MCw1MCwwLjEyKTsgY29sb3I6IHZhcigtLWVycm9yKTsgfQouYWRkLWxpbmUtYnRuIHsgYmFja2dyb3VuZDogdHJhbnNwYXJlbnQ7IGJvcmRlcjogMS41cHggZGFzaGVkIHZhcigtLWxpbmUpOyBib3JkZXItcmFkaXVzOiA4cHg7IHBhZGRpbmc6IDhweCAxNnB4OyBmb250LWZhbWlseTogJ0luc3RydW1lbnQgU2FucycsIHNhbnMtc2VyaWY7IGZvbnQtc2l6ZTogMC44MnJlbTsgY29sb3I6IHZhcigtLW11dGVkKTsgY3Vyc29yOiBwb2ludGVyOyB3aWR0aDogMTAwJTsgdHJhbnNpdGlvbjogYWxsIC4yczsgbWFyZ2luLXRvcDogNHB4OyB9Ci5hZGQtbGluZS1idG46aG92ZXIgeyBib3JkZXItY29sb3I6IHZhcigtLWdvbGQpOyBjb2xvcjogdmFyKC0tZ29sZCk7IH0KLnRvdGFsLXJvdyB7IGRpc3BsYXk6IGZsZXg7IGp1c3RpZnktY29udGVudDogc3BhY2UtYmV0d2VlbjsgYWxpZ24taXRlbXM6IGNlbnRlcjsgcGFkZGluZzogMTRweCAwIDRweDsgYm9yZGVyLXRvcDogMnB4IHNvbGlkIHZhcigtLWluayk7IG1hcmdpbi10b3A6IDEwcHg7IH0KLnRvdGFsLXJvdyBzcGFuOmZpcnN0LWNoaWxkIHsgZm9udC13ZWlnaHQ6IDcwMDsgfQoudG90YWwtYW1vdW50IHsgZm9udC1mYW1pbHk6ICdGcmF1bmNlcycsIHNlcmlmOyBmb250LXNpemU6IDEuNnJlbTsgZm9udC13ZWlnaHQ6IDkwMDsgY29sb3I6IHZhcigtLWdvbGQpOyB9CgovKiBTVFJJUEUgSEVMUEVSICovCi5zdHJpcGUtaGVscGVyIHsgYmFja2dyb3VuZDogcmdiYSg5OSw5MSwyNTUsMC4wNSk7IGJvcmRlcjogMXB4IHNvbGlkIHJnYmEoOTksOTEsMjU1LDAuMTUpOyBib3JkZXItcmFkaXVzOiAxMnB4OyBwYWRkaW5nOiAxNnB4IDE4cHg7IG1hcmdpbi1ib3R0b206IDE0cHg7IH0KLnN0cmlwZS1oZWxwZXItdGl0bGUgeyBmb250LXNpemU6IDAuNzVyZW07IGZvbnQtd2VpZ2h0OiA3MDA7IHRleHQtdHJhbnNmb3JtOiB1cHBlcmNhc2U7IGxldHRlci1zcGFjaW5nOiAwLjA4ZW07IGNvbG9yOiAjNjM1NmZmOyBtYXJnaW4tYm90dG9tOiAxMHB4OyB9Ci5zdHJpcGUtc3RlcHMgeyBmb250LXNpemU6IDAuODJyZW07IGNvbG9yOiB2YXIoLS1zbGF0ZSk7IGxpbmUtaGVpZ2h0OiAxLjk7IG1hcmdpbi1ib3R0b206IDEycHg7IH0KLnN0cmlwZS1zdGVwcyBzdHJvbmcgeyBjb2xvcjogdmFyKC0taW5rKTsgfQouc3RyaXBlLWFtdCB7IGRpc3BsYXk6IGlubGluZS1ibG9jazsgYmFja2dyb3VuZDogcmdiYSg5OSw5MSwyNTUsMC4xKTsgYm9yZGVyLXJhZGl1czogNnB4OyBwYWRkaW5nOiAxcHggOXB4OyBmb250LXdlaWdodDogNzAwOyBjb2xvcjogIzYzNTZmZjsgZm9udC1zaXplOiAwLjgycmVtOyB9Ci5zdHJpcGUtb3Blbi1idG4geyBkaXNwbGF5OiBpbmxpbmUtZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiA3cHg7IGJhY2tncm91bmQ6ICM2MzU2ZmY7IGNvbG9yOiB3aGl0ZTsgYm9yZGVyOiBub25lOyBib3JkZXItcmFkaXVzOiA4cHg7IHBhZGRpbmc6IDlweCAxOHB4OyBmb250LWZhbWlseTogJ0luc3RydW1lbnQgU2FucycsIHNhbnMtc2VyaWY7IGZvbnQtc2l6ZTogMC44MnJlbTsgZm9udC13ZWlnaHQ6IDcwMDsgY3Vyc29yOiBwb2ludGVyOyB0ZXh0LWRlY29yYXRpb246IG5vbmU7IHRyYW5zaXRpb246IGJhY2tncm91bmQgLjJzOyB9Ci5zdHJpcGUtb3Blbi1idG46aG92ZXIgeyBiYWNrZ3JvdW5kOiAjNGY0M2UwOyB9CgovKiBCVVRUT05TICovCi5hY3Rpb24tcm93IHsgZGlzcGxheTogZmxleDsgZ2FwOiAxMHB4OyBtYXJnaW4tdG9wOiAyMHB4OyBmbGV4LXdyYXA6IHdyYXA7IH0KLmJ0bi1wcmltYXJ5IHsgZmxleDogMjsgbWluLXdpZHRoOiAyMDBweDsgYmFja2dyb3VuZDogdmFyKC0taW5rKTsgY29sb3I6IHZhcigtLXdoaXRlKTsgYm9yZGVyOiBub25lOyBib3JkZXItcmFkaXVzOiAxMHB4OyBwYWRkaW5nOiAxNHB4OyBmb250LWZhbWlseTogJ0luc3RydW1lbnQgU2FucycsIHNhbnMtc2VyaWY7IGZvbnQtc2l6ZTogMC45NXJlbTsgZm9udC13ZWlnaHQ6IDcwMDsgY3Vyc29yOiBwb2ludGVyOyB0cmFuc2l0aW9uOiBiYWNrZ3JvdW5kIC4yczsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsganVzdGlmeS1jb250ZW50OiBjZW50ZXI7IGdhcDogOHB4OyB9Ci5idG4tcHJpbWFyeTpob3ZlciB7IGJhY2tncm91bmQ6IHZhcigtLWdvbGQpOyB9Ci5idG4tcHJpbWFyeTpkaXNhYmxlZCB7IG9wYWNpdHk6IDAuNTsgY3Vyc29yOiBub3QtYWxsb3dlZDsgfQouYnRuLXNlY29uZGFyeSB7IGZsZXg6IDE7IG1pbi13aWR0aDogMTQwcHg7IGJhY2tncm91bmQ6IHRyYW5zcGFyZW50OyBjb2xvcjogdmFyKC0taW5rKTsgYm9yZGVyOiAxLjVweCBzb2xpZCB2YXIoLS1saW5lKTsgYm9yZGVyLXJhZGl1czogMTBweDsgcGFkZGluZzogMTRweDsgZm9udC1mYW1pbHk6ICdJbnN0cnVtZW50IFNhbnMnLCBzYW5zLXNlcmlmOyBmb250LXNpemU6IDAuOXJlbTsgZm9udC13ZWlnaHQ6IDYwMDsgY3Vyc29yOiBwb2ludGVyOyB0cmFuc2l0aW9uOiBhbGwgLjJzOyBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBqdXN0aWZ5LWNvbnRlbnQ6IGNlbnRlcjsgZ2FwOiA3cHg7IH0KLmJ0bi1zZWNvbmRhcnk6aG92ZXIgeyBib3JkZXItY29sb3I6IHZhcigtLWluayk7IGJhY2tncm91bmQ6IHZhcigtLXN0b25lKTsgfQouc3Bpbm5lciB7IHdpZHRoOiAxNnB4OyBoZWlnaHQ6IDE2cHg7IGJvcmRlcjogMi41cHggc29saWQgcmdiYSgyNTUsMjU1LDI1NSwwLjMpOyBib3JkZXItdG9wLWNvbG9yOiB3aGl0ZTsgYm9yZGVyLXJhZGl1czogNTAlOyBhbmltYXRpb246IHNwaW4gLjdzIGxpbmVhciBpbmZpbml0ZTsgZGlzcGxheTogbm9uZTsgfQpAa2V5ZnJhbWVzIHNwaW4geyB0byB7IHRyYW5zZm9ybTogcm90YXRlKDM2MGRlZyk7IH0gfQouc3RhdHVzLW1zZyB7IGJvcmRlci1yYWRpdXM6IDEwcHg7IHBhZGRpbmc6IDEzcHggMThweDsgZm9udC1zaXplOiAwLjg1cmVtOyBmb250LXdlaWdodDogNjAwOyBtYXJnaW4tdG9wOiAxMnB4OyBkaXNwbGF5OiBub25lOyBsaW5lLWhlaWdodDogMS41OyB9Ci5zdGF0dXMtbXNnLnN1Y2Nlc3MgeyBiYWNrZ3JvdW5kOiByZ2JhKDQyLDEyMiw4MiwwLjA4KTsgYm9yZGVyOiAxcHggc29saWQgcmdiYSg0MiwxMjIsODIsMC4yNSk7IGNvbG9yOiB2YXIoLS1zdWNjZXNzKTsgfQouc3RhdHVzLW1zZy5lcnJvciB7IGJhY2tncm91bmQ6IHJnYmEoMTg0LDUwLDUwLDAuMDcpOyBib3JkZXI6IDFweCBzb2xpZCByZ2JhKDE4NCw1MCw1MCwwLjIpOyBjb2xvcjogdmFyKC0tZXJyb3IpOyB9CgovKiBQUkVWSUVXICovCi5wcmV2aWV3LWxhYmVsIHsgZm9udC1zaXplOiAwLjcycmVtOyBmb250LXdlaWdodDogNzAwOyB0ZXh0LXRyYW5zZm9ybTogdXBwZXJjYXNlOyBsZXR0ZXItc3BhY2luZzogMC4wOGVtOyBjb2xvcjogdmFyKC0tbXV0ZWQpOyBtYXJnaW4tYm90dG9tOiAxMHB4OyBtYXJnaW4tdG9wOiA4cHg7IH0KLnByZXZpZXctY2FyZCB7IGJhY2tncm91bmQ6IHZhcigtLXdoaXRlKTsgYm9yZGVyLXJhZGl1czogMTRweDsgb3ZlcmZsb3c6IGhpZGRlbjsgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tbGluZSk7IGZvbnQtc2l6ZTogMTNweDsgYm94LXNoYWRvdzogMCA0cHggMjBweCByZ2JhKDI4LDI4LDI4LDAuMDYpOyB9Ci5wLWhlYWRlciB7IGJhY2tncm91bmQ6IHZhcigtLWluayk7IHBhZGRpbmc6IDE2cHggMjJweDsgfQoucC1sb2dvIHsgZm9udC13ZWlnaHQ6IDkwMDsgY29sb3I6IHdoaXRlOyBmb250LXN0eWxlOiBpdGFsaWM7IGZvbnQtc2l6ZTogMTZweDsgfQoucC1zdWIgeyBjb2xvcjogcmdiYSgyNTUsMjU1LDI1NSwwLjQpOyBmb250LXNpemU6IDExcHg7IG1hcmdpbi10b3A6IDNweDsgfQoucC1iYXIgeyBiYWNrZ3JvdW5kOiB2YXIoLS1nb2xkKTsgcGFkZGluZzogMTBweCAyMnB4OyBkaXNwbGF5OiBmbGV4OyBqdXN0aWZ5LWNvbnRlbnQ6IHNwYWNlLWJldHdlZW47IGFsaWduLWl0ZW1zOiBjZW50ZXI7IH0KLnAtYmFyIHNwYW4geyBjb2xvcjogd2hpdGU7IGZvbnQtd2VpZ2h0OiA3MDA7IGZvbnQtc2l6ZTogMTJweDsgfQoucC1ib2R5IHsgcGFkZGluZzogMjBweCAyMnB4OyB9Ci5wLW1ldGEgeyBkaXNwbGF5OiBmbGV4OyBnYXA6IDE2cHg7IGZsZXgtd3JhcDogd3JhcDsgbWFyZ2luLWJvdHRvbTogMTRweDsgfQoucC1tZXRhLWl0ZW0geyBmb250LXNpemU6IDExcHg7IH0KLnAtbWV0YS1sYWJlbCB7IGNvbG9yOiB2YXIoLS1tdXRlZCk7IGZvbnQtd2VpZ2h0OiA3MDA7IHRleHQtdHJhbnNmb3JtOiB1cHBlcmNhc2U7IGxldHRlci1zcGFjaW5nOiAwLjA2ZW07IGRpc3BsYXk6IGJsb2NrOyBtYXJnaW4tYm90dG9tOiAycHg7IGZvbnQtc2l6ZTogMTBweDsgfQoucC1tZXRhLXZhbCB7IGNvbG9yOiB2YXIoLS1pbmspOyBmb250LXdlaWdodDogNjAwOyB9Ci5wLWRlc2MgeyBiYWNrZ3JvdW5kOiB2YXIoLS1zdG9uZSk7IGJvcmRlci1sZWZ0OiAzcHggc29saWQgdmFyKC0tZ29sZCk7IHBhZGRpbmc6IDEwcHggMTRweDsgYm9yZGVyLXJhZGl1czogMCA4cHggOHB4IDA7IGZvbnQtc2l6ZTogMTJweDsgY29sb3I6IHZhcigtLXNsYXRlKTsgbWFyZ2luLWJvdHRvbTogMTRweDsgbGluZS1oZWlnaHQ6IDEuNjU7IHdoaXRlLXNwYWNlOiBwcmUtd3JhcDsgd29yZC1icmVhazogYnJlYWstd29yZDsgfQoucC1saW5lcyB7IHdpZHRoOiAxMDAlOyBib3JkZXItY29sbGFwc2U6IGNvbGxhcHNlOyBmb250LXNpemU6IDEycHg7IG1hcmdpbi1ib3R0b206IDEwcHg7IH0KLnAtbGluZXMgdGQgeyBwYWRkaW5nOiA2cHggMDsgYm9yZGVyLWJvdHRvbTogMXB4IHNvbGlkIHZhcigtLWxpbmUpOyBjb2xvcjogdmFyKC0tc2xhdGUpOyB9Ci5wLWxpbmVzIHRkOmxhc3QtY2hpbGQgeyB0ZXh0LWFsaWduOiByaWdodDsgZm9udC13ZWlnaHQ6IDYwMDsgd2hpdGUtc3BhY2U6IG5vd3JhcDsgfQoucC10b3RhbC1yb3cgeyBkaXNwbGF5OiBmbGV4OyBqdXN0aWZ5LWNvbnRlbnQ6IHNwYWNlLWJldHdlZW47IGFsaWduLWl0ZW1zOiBjZW50ZXI7IHBhZGRpbmc6IDEwcHggMCAxNHB4OyB9Ci5wLXRvdGFsLWxhYmVsIHsgZm9udC13ZWlnaHQ6IDcwMDsgZm9udC1zaXplOiAxM3B4OyB9Ci5wLXRvdGFsLWFtdCB7IGZvbnQtZmFtaWx5OiAnRnJhdW5jZXMnLCBzZXJpZjsgZm9udC1zaXplOiAxLjNyZW07IGZvbnQtd2VpZ2h0OiA5MDA7IGNvbG9yOiB2YXIoLS1nb2xkKTsgfQoucC1wYXktYnRuIHsgZGlzcGxheTogYmxvY2s7IGJhY2tncm91bmQ6IHZhcigtLWluayk7IGNvbG9yOiB3aGl0ZTsgdGV4dC1hbGlnbjogY2VudGVyOyBwYWRkaW5nOiAxMXB4OyBib3JkZXItcmFkaXVzOiA4cHg7IGZvbnQtd2VpZ2h0OiA3MDA7IGZvbnQtc2l6ZTogMTNweDsgdGV4dC1kZWNvcmF0aW9uOiBub25lOyBtYXJnaW4tYm90dG9tOiA0cHg7IH0KLnAtbm90ZXMgeyBiYWNrZ3JvdW5kOiB2YXIoLS1zdG9uZSk7IGJvcmRlci1yYWRpdXM6IDhweDsgcGFkZGluZzogMTBweCAxNHB4OyBmb250LXNpemU6IDExcHg7IGNvbG9yOiB2YXIoLS1tdXRlZCk7IGxpbmUtaGVpZ2h0OiAxLjY7IG1hcmdpbi10b3A6IDEwcHg7IGRpc3BsYXk6IG5vbmU7IHdoaXRlLXNwYWNlOiBwcmUtd3JhcDsgfQoucC1kdWUtbGluZSB7IGZvbnQtc2l6ZTogMTFweDsgY29sb3I6IHZhcigtLW11dGVkKTsgdGV4dC1hbGlnbjogY2VudGVyOyBtYXJnaW4tdG9wOiA2cHg7IGRpc3BsYXk6IG5vbmU7IH0KCkBtZWRpYShtYXgtd2lkdGg6NjAwcHgpIHsgLmZpZWxkLXJvdyB7IGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47IGdhcDogMDsgfSAuY2FyZCB7IHBhZGRpbmc6IDIycHg7IH0gLmFjdGlvbi1yb3cgeyBmbGV4LWRpcmVjdGlvbjogY29sdW1uOyB9IC5idG4tcHJpbWFyeSwgLmJ0bi1zZWNvbmRhcnkgeyBmbGV4OiBub25lOyB3aWR0aDogMTAwJTsgfSB9Cjwvc3R5bGU+CjwvaGVhZD4KPGJvZHk+Cgo8ZGl2IGlkPSJtYWluQ29udGVudCI+CjxkaXYgY2xhc3M9InBhZ2UiPgoKICA8ZGl2IGNsYXNzPSJwYWdlLWhlYWRlciI+CiAgICA8ZGl2IGNsYXNzPSJsb2dvIj5Ib21lPHNwYW4+IDEwMTwvc3Bhbj48L2Rpdj4KICAgIDxzcGFuIGNsYXNzPSJiYWRnZSI+SW50ZXJuYWwg4oCUIFNlbmQgUXVvdGU8L3NwYW4+CiAgICA8YnV0dG9uIG9uY2xpY2s9ImZldGNoKCcvYXBpL2xvZ291dCcse21ldGhvZDonUE9TVCcsY3JlZGVudGlhbHM6J2luY2x1ZGUnfSkudGhlbigoKT0+bG9jYXRpb24uaHJlZj0nL2ludm9pY2UnKSIgc3R5bGU9ImJhY2tncm91bmQ6dHJhbnNwYXJlbnQ7Ym9yZGVyOjEuNXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6OHB4O3BhZGRpbmc6NnB4IDE0cHg7Zm9udC1mYW1pbHk6J0luc3RydW1lbnQgU2Fucycsc2Fucy1zZXJpZjtmb250LXNpemU6MC43OHJlbTtmb250LXdlaWdodDo2MDA7Y29sb3I6dmFyKC0tbXV0ZWQpO2N1cnNvcjpwb2ludGVyOyI+TG9nIG91dDwvYnV0dG9uPgogICAgPGJ1dHRvbiBvbmNsaWNrPSJsb2dvdXQoKSIgc3R5bGU9ImJhY2tncm91bmQ6dHJhbnNwYXJlbnQ7Ym9yZGVyOjEuNXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6OHB4O3BhZGRpbmc6NnB4IDE0cHg7Zm9udC1mYW1pbHk6J0luc3RydW1lbnQgU2Fucycsc2Fucy1zZXJpZjtmb250LXNpemU6MC43OHJlbTtmb250LXdlaWdodDo2MDA7Y29sb3I6dmFyKC0tbXV0ZWQpO2N1cnNvcjpwb2ludGVyOyIgb25tb3VzZW92ZXI9InRoaXMuc3R5bGUuY29sb3I9J3ZhcigtLWluayknIiBvbm1vdXNlb3V0PSJ0aGlzLnN0eWxlLmNvbG9yPSd2YXIoLS1tdXRlZCknIj5Mb2cgb3V0PC9idXR0b24+CiAgPC9kaXY+CiAgPGRpdiBjbGFzcz0icHJlZmlsbC1iYW5uZXIiIGlkPSJwcmVmaWxsQmFubmVyIj48L2Rpdj4KCiAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICA8ZGl2IGNsYXNzPSJjYXJkLXRpdGxlIj4KICAgICAgPHN2ZyB3aWR0aD0iMTYiIGhlaWdodD0iMTYiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMjAgMjF2LTJhNCA0IDAgMCAwLTQtNEg4YTQgNCAwIDAgMC00IDR2MiIvPjxjaXJjbGUgY3g9IjEyIiBjeT0iNyIgcj0iNCIvPjwvc3ZnPgogICAgICBDdXN0b21lciBEZXRhaWxzCiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImZpZWxkLXJvdyI+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+RnVsbCBOYW1lPC9sYWJlbD48aW5wdXQgdHlwZT0idGV4dCIgaWQ9ImN1c3RvbWVyTmFtZSIgcGxhY2Vob2xkZXI9IkphbmUgU21pdGgiIG9uaW5wdXQ9InVwZGF0ZVByZXZpZXcoKSIgLz48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5QaG9uZTwvbGFiZWw+PGlucHV0IHR5cGU9InRlbCIgaWQ9ImN1c3RvbWVyUGhvbmUiIHBsYWNlaG9sZGVyPSIoNDAzKSA1NTUtMDE5MiIgb25pbnB1dD0idXBkYXRlUHJldmlldygpIiAvPjwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkVtYWlsIEFkZHJlc3M8L2xhYmVsPjxpbnB1dCB0eXBlPSJlbWFpbCIgaWQ9ImN1c3RvbWVyRW1haWwiIHBsYWNlaG9sZGVyPSJqYW5lQGV4YW1wbGUuY29tIiBvbmlucHV0PSJ1cGRhdGVQcmV2aWV3KCkiIC8+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlNlcnZpY2UgQWRkcmVzczwvbGFiZWw+PGlucHV0IHR5cGU9InRleHQiIGlkPSJhZGRyZXNzIiBwbGFjZWhvbGRlcj0iNDIgTWFwbGUgU3RyZWV0LCBDYWxnYXJ5LCBBQiIgb25pbnB1dD0idXBkYXRlUHJldmlldygpIiAvPjwvZGl2PgogIDwvZGl2PgoKICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgIDxkaXYgY2xhc3M9ImNhcmQtdGl0bGUiPgogICAgICA8c3ZnIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxwYXRoIGQ9Ik0xNC43IDYuM2ExIDEgMCAwIDAgMCAxLjRsMS42IDEuNmExIDEgMCAwIDAgMS40IDBsMy43Ny0zLjc3YTYgNiAwIDAgMS03Ljk0IDcuOTRsLTYuOTEgNi45MWEyLjEyIDIuMTIgMCAwIDEtMy0zbDYuOTEtNi45MWE2IDYgMCAwIDEgNy45NC03Ljk0bC0zLjc2IDMuNzZ6Ii8+PC9zdmc+CiAgICAgIEpvYiBEZXRhaWxzCiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+V29yayBEZXNjcmlwdGlvbjwvbGFiZWw+PHRleHRhcmVhIGlkPSJqb2JEZXNjcmlwdGlvbiIgcGxhY2Vob2xkZXI9ImUuZy4gUmVwbGFjZSBraXRjaGVuIHRhcCBhbmQgcmVwYWlyIGNvcnJvZGVkIHBpcGUgdW5kZXIgc2luay4gTGFib3VyIGFuZCBtYXRlcmlhbHMgaW5jbHVkZWQuIiBvbmlucHV0PSJ1cGRhdGVQcmV2aWV3KCkiPjwvdGV4dGFyZWE+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+CiAgICAgIDxsYWJlbD5RdW90ZSBCcmVha2Rvd248L2xhYmVsPgogICAgICA8ZGl2IGlkPSJsaW5lSXRlbXMiPjwvZGl2PgogICAgICA8YnV0dG9uIGNsYXNzPSJhZGQtbGluZS1idG4iIG9uY2xpY2s9ImFkZExpbmVJdGVtKCkiPisgQWRkIGxpbmUgaXRlbTwvYnV0dG9uPgogICAgICA8ZGl2IGNsYXNzPSJ0b3RhbC1yb3ciPjxzcGFuPlRvdGFsIChDQUQpPC9zcGFuPjxzcGFuIGNsYXNzPSJ0b3RhbC1hbW91bnQiIGlkPSJ0b3RhbERpc3BsYXkiPiQwLjAwPC9zcGFuPjwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJmaWVsZC1yb3ciPgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkR1ZSBEYXRlIDxzcGFuIHN0eWxlPSJmb250LXdlaWdodDo0MDA7dGV4dC10cmFuc2Zvcm06bm9uZTsiPihvcHRpb25hbCk8L3NwYW4+PC9sYWJlbD48aW5wdXQgdHlwZT0idGV4dCIgaWQ9ImR1ZURhdGUiIHBsYWNlaG9sZGVyPSJlLmcuIEFwcmlsIDUsIDIwMjYiIG9uaW5wdXQ9InVwZGF0ZVByZXZpZXcoKSIgLz48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5SZWZlcmVuY2UgIyA8c3BhbiBzdHlsZT0iZm9udC13ZWlnaHQ6NDAwO3RleHQtdHJhbnNmb3JtOm5vbmU7Ij4ob3B0aW9uYWwpPC9zcGFuPjwvbGFiZWw+PGlucHV0IHR5cGU9InRleHQiIGlkPSJyZWZlcmVuY2UiIHBsYWNlaG9sZGVyPSJBdXRvLWdlbmVyYXRlZCBpZiBibGFuayIgb25pbnB1dD0idXBkYXRlUHJldmlldygpIiAvPjwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPk5vdGVzIDxzcGFuIHN0eWxlPSJmb250LXdlaWdodDo0MDA7dGV4dC10cmFuc2Zvcm06bm9uZTsiPihvcHRpb25hbCk8L3NwYW4+PC9sYWJlbD48dGV4dGFyZWEgaWQ9Im5vdGVzIiByb3dzPSIyIiBwbGFjZWhvbGRlcj0iZS5nLiBQcmljZSB2YWxpZCBmb3IgMTQgZGF5cy4gRXhjbHVkZXMgZGFtYWdlIGZvdW5kIGR1cmluZyByZXBhaXIuIiBvbmlucHV0PSJ1cGRhdGVQcmV2aWV3KCkiPjwvdGV4dGFyZWE+PC9kaXY+CiAgPC9kaXY+CgogIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgPGRpdiBjbGFzcz0iY2FyZC10aXRsZSI+CiAgICAgIDxzdmcgd2lkdGg9IjE2IiBoZWlnaHQ9IjE2IiB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHJlY3QgeD0iMSIgeT0iNCIgd2lkdGg9IjIyIiBoZWlnaHQ9IjE2IiByeD0iMiIgcnk9IjIiLz48bGluZSB4MT0iMSIgeTE9IjEwIiB4Mj0iMjMiIHkyPSIxMCIvPjwvc3ZnPgogICAgICBQYXltZW50CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9InN0cmlwZS1oZWxwZXIiPgogICAgICA8ZGl2IGNsYXNzPSJzdHJpcGUtaGVscGVyLXRpdGxlIj5RdWljayBTdHJpcGUgUGF5bWVudCBMaW5rPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InN0cmlwZS1zdGVwcyI+CiAgICAgICAgMS4gQ2xpY2sgPHN0cm9uZz5PcGVuIFN0cmlwZTwvc3Ryb25nPiBiZWxvdyDigJQgZ29lcyB0byB5b3VyIFBheW1lbnQgTGlua3MgZGFzaGJvYXJkPGJyPgogICAgICAgIDIuIENsaWNrIDxzdHJvbmc+Q3JlYXRlIGxpbms8L3N0cm9uZz4sIHNldCBhbW91bnQgdG8gPHNwYW4gY2xhc3M9InN0cmlwZS1hbXQiIGlkPSJzdHJpcGVBbW91bnRIaW50Ij4kMC4wMDwvc3Bhbj4gYW5kIGFkZCBhIGRlc2NyaXB0aW9uPGJyPgogICAgICAgIDMuIENvcHkgdGhlIGxpbmsgKHN0YXJ0cyB3aXRoIDxjb2RlIHN0eWxlPSJiYWNrZ3JvdW5kOnJnYmEoMCwwLDAsMC4wNik7cGFkZGluZzoxcHggNXB4O2JvcmRlci1yYWRpdXM6NHB4OyI+YnV5LnN0cmlwZS5jb20vLi4uPC9jb2RlPikgYW5kIHBhc3RlIGJlbG93CiAgICAgIDwvZGl2PgogICAgICA8YSBocmVmPSJodHRwczovL2Rhc2hib2FyZC5zdHJpcGUuY29tL3BheW1lbnQtbGlua3MiIHRhcmdldD0iX2JsYW5rIiBjbGFzcz0ic3RyaXBlLW9wZW4tYnRuIj4KICAgICAgICA8c3ZnIHdpZHRoPSIxMyIgaGVpZ2h0PSIxMyIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyLjUiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHBhdGggZD0iTTE4IDEzdjZhMiAyIDAgMCAxLTIgMkg1YTIgMiAwIDAgMS0yLTJWOGEyIDIgMCAwIDEgMi0yaDYiLz48cG9seWxpbmUgcG9pbnRzPSIxNSAzIDIxIDMgMjEgOSIvPjxsaW5lIHgxPSIxMCIgeTE9IjE0IiB4Mj0iMjEiIHkyPSIzIi8+PC9zdmc+CiAgICAgICAgT3BlbiBTdHJpcGUgRGFzaGJvYXJkCiAgICAgIDwvYT4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0iZmllbGQiPgogICAgICA8bGFiZWw+U3RyaXBlIFBheW1lbnQgTGluazwvbGFiZWw+CiAgICAgIDxpbnB1dCB0eXBlPSJ1cmwiIGlkPSJzdHJpcGVQYXltZW50TGluayIgcGxhY2Vob2xkZXI9Imh0dHBzOi8vYnV5LnN0cmlwZS5jb20veHh4eHh4eHgiIG9uaW5wdXQ9InVwZGF0ZVByZXZpZXcoKSIgLz4KICAgICAgPHAgY2xhc3M9ImZpZWxkLWhpbnQiPlBhc3RlIHRoZSBsaW5rIGdlbmVyYXRlZCBmcm9tIFN0cmlwZSBhYm92ZS48L3A+CiAgICA8L2Rpdj4KICA8L2Rpdj4KCiAgPHAgY2xhc3M9InByZXZpZXctbGFiZWwiPkxpdmUgRW1haWwgUHJldmlldzwvcD4KICA8ZGl2IGNsYXNzPSJwcmV2aWV3LWNhcmQiPgogICAgPGRpdiBjbGFzcz0icC1oZWFkZXIiPgogICAgICA8ZGl2IGNsYXNzPSJwLWxvZ28iPkhvbWUgMTAxPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InAtc3ViIj5RdW90ZSAmYW1wOyBQYXltZW50IOKAlCA8c3BhbiBpZD0icC1kYXRlIj48L3NwYW4+PC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9InAtYmFyIj4KICAgICAgPHNwYW4gaWQ9InAtcmVmIj5SRUY6IOKAlDwvc3Bhbj4KICAgICAgPHNwYW4+UXVvdGU8L3NwYW4+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9InAtYm9keSI+CiAgICAgIDxkaXYgY2xhc3M9InAtbWV0YSI+CiAgICAgICAgPGRpdiBjbGFzcz0icC1tZXRhLWl0ZW0iPjxzcGFuIGNsYXNzPSJwLW1ldGEtbGFiZWwiPlRvPC9zcGFuPjxzcGFuIGNsYXNzPSJwLW1ldGEtdmFsIiBpZD0icC1uYW1lIj7igJQ8L3NwYW4+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0icC1tZXRhLWl0ZW0iPjxzcGFuIGNsYXNzPSJwLW1ldGEtbGFiZWwiPkVtYWlsPC9zcGFuPjxzcGFuIGNsYXNzPSJwLW1ldGEtdmFsIiBpZD0icC1lbWFpbCI+4oCUPC9zcGFuPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InAtbWV0YS1pdGVtIj48c3BhbiBjbGFzcz0icC1tZXRhLWxhYmVsIj5QaG9uZTwvc3Bhbj48c3BhbiBjbGFzcz0icC1tZXRhLXZhbCIgaWQ9InAtcGhvbmUiPuKAlDwvc3Bhbj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJwLW1ldGEtaXRlbSI+PHNwYW4gY2xhc3M9InAtbWV0YS1sYWJlbCI+QWRkcmVzczwvc3Bhbj48c3BhbiBjbGFzcz0icC1tZXRhLXZhbCIgaWQ9InAtYWRkciI+4oCUPC9zcGFuPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InAtbWV0YS1pdGVtIiBpZD0icC1kdWUtd3JhcCIgc3R5bGU9ImRpc3BsYXk6bm9uZTsiPjxzcGFuIGNsYXNzPSJwLW1ldGEtbGFiZWwiPkR1ZTwvc3Bhbj48c3BhbiBjbGFzcz0icC1tZXRhLXZhbCIgaWQ9InAtZHVlIj7igJQ8L3NwYW4+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0icC1tZXRhLWl0ZW0iPjxzcGFuIGNsYXNzPSJwLW1ldGEtbGFiZWwiPlJlZjwvc3Bhbj48c3BhbiBjbGFzcz0icC1tZXRhLXZhbCIgaWQ9InAtcmVmLWlubGluZSI+4oCUPC9zcGFuPjwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0icC1kZXNjIiBpZD0icC1kZXNjIj5Xb3JrIGRlc2NyaXB0aW9uIHdpbGwgYXBwZWFyIGhlcmXigKY8L2Rpdj4KICAgICAgPHRhYmxlIGNsYXNzPSJwLWxpbmVzIiBpZD0icC1saW5lcyI+PHRyPjx0ZCBjb2xzcGFuPSIyIiBzdHlsZT0iY29sb3I6dmFyKC0tbXV0ZWQpO2ZvbnQtc2l6ZToxMXB4O3BhZGRpbmc6NnB4IDA7Ij5ObyBsaW5lIGl0ZW1zIHlldDwvdGQ+PC90cj48L3RhYmxlPgogICAgICA8ZGl2IGNsYXNzPSJwLXRvdGFsLXJvdyI+PHNwYW4gY2xhc3M9InAtdG90YWwtbGFiZWwiPlRvdGFsIChDQUQpPC9zcGFuPjxzcGFuIGNsYXNzPSJwLXRvdGFsLWFtdCIgaWQ9InAtdG90YWwiPiQwLjAwPC9zcGFuPjwvZGl2PgogICAgICA8YSBjbGFzcz0icC1wYXktYnRuIiBpZD0icC1wYXlidG4iIGhyZWY9IiMiPlBheSBOb3cg4oCUICQwLjAwPC9hPgogICAgICA8cCBjbGFzcz0icC1kdWUtbGluZSIgaWQ9InAtZHVlLWxpbmUiPjwvcD4KICAgICAgPGRpdiBjbGFzcz0icC1ub3RlcyIgaWQ9InAtbm90ZXMtYm94Ij48L2Rpdj4KICAgIDwvZGl2PgogIDwvZGl2PgoKICA8ZGl2IGNsYXNzPSJhY3Rpb24tcm93Ij4KICAgIDxidXR0b24gY2xhc3M9ImJ0bi1wcmltYXJ5IiBpZD0ic2VuZEJ0biIgb25jbGljaz0ic2VuZEludm9pY2UoKSI+CiAgICAgIDxzdmcgd2lkdGg9IjE1IiBoZWlnaHQ9IjE1IiB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PGxpbmUgeDE9IjIyIiB5MT0iMiIgeDI9IjExIiB5Mj0iMTMiLz48cG9seWdvbiBwb2ludHM9IjIyIDIgMTUgMjIgMTEgMTMgMiA5IDIyIDIiLz48L3N2Zz4KICAgICAgPHNwYW4gaWQ9InNlbmRUZXh0Ij5TZW5kIFF1b3RlIHRvIEN1c3RvbWVyPC9zcGFuPgogICAgICA8ZGl2IGNsYXNzPSJzcGlubmVyIiBpZD0ic2VuZFNwaW5uZXIiPjwvZGl2PgogICAgPC9idXR0b24+CiAgICA8YnV0dG9uIGNsYXNzPSJidG4tc2Vjb25kYXJ5IiBvbmNsaWNrPSJkb3dubG9hZFBERigpIj4KICAgICAgPHN2ZyB3aWR0aD0iMTQiIGhlaWdodD0iMTQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMjEgMTV2NGEyIDIgMCAwIDEtMiAySDVhMiAyIDAgMCAxLTItMnYtNCIvPjxwb2x5bGluZSBwb2ludHM9IjcgMTAgMTIgMTUgMTcgMTAiLz48bGluZSB4MT0iMTIiIHkxPSIxNSIgeDI9IjEyIiB5Mj0iMyIvPjwvc3ZnPgogICAgICBEb3dubG9hZCBQREYKICAgIDwvYnV0dG9uPgogIDwvZGl2PgogIDxkaXYgY2xhc3M9InN0YXR1cy1tc2ciIGlkPSJzdGF0dXNNc2ciPjwvZGl2PgoKPC9kaXY+CjwvZGl2PgoKPHNjcmlwdD4KY29uc3QgQkFDS0VORF9VUkwgPSAnJzsKCiAgaW5pdCgpOwo8L3NjcmlwdD4KPC9ib2R5Pgo8L2h0bWw+';

function getInvoiceAppHtml() {
  return Buffer.from(INVOICE_HTML_B64, 'base64').toString('utf8');
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



// ── GET /api/hash-password — generate a scrypt hash of your password ──────────
// Visit: /api/hash-password?p=YourPlainPassword
// Copy the $scrypt$... output into INVOICE_PASSWORD env var on Vercel.
// After that you enter your PLAIN password to log in — the server hashes it
// and compares. Delete this route once done.
app.get('/api/hash-password', (req, res) => {
  const p = req.query.p;
  if (!p) return res.status(400).send('Usage: /api/hash-password?p=yourpassword');
  const salt = crypto.randomBytes(32);
  crypto.scrypt(p, salt, 64, (err, hash) => {
    if (err) return res.status(500).send('Error: ' + err.message);
    const stored = '$scrypt$' + salt.toString('hex') + '$' + hash.toString('hex');
    res.setHeader('Content-Type', 'text/html');
    res.send('<div style="font-family:monospace;padding:30px;background:#f7f4ef">'
      + '<h2 style="margin-bottom:12px">Password Hash</h2>'
      + '<p style="margin-bottom:8px">Set <strong>INVOICE_PASSWORD</strong> to:</p>'
      + '<pre style="background:#fff;padding:12px;border-radius:8px;word-break:break-all">' + stored + '</pre>'
      + '<p style="margin-top:8px;color:#555">You will still log in with your plain password.</p>'
      + '</div>');
  });
});

app.get('/health', (_, res) => res.json({ status: 'ok' }));

// Listen locally in dev; export for Vercel serverless in production
if (require.main === module) {
  app.listen(PORT, () => console.log(`Home 101 API running on http://localhost:${PORT}`));
}
module.exports = app;
