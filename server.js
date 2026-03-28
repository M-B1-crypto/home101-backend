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
  const invoiceBase = process.env.INVOICE_TOOL_URL || '/invoice/app';
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
const COOKIE_SECRET = process.env.SESSION_SECRET || process.env.TURNSTILE_SECRET_KEY || 'fallback-dev-secret-change-in-prod';
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
    + (req.query.next ? '<input type="hidden" name="next" value="' + String(req.query.next).replace(/"/g,'&quot;').replace(/</g,'').replace(/>/g,'').slice(0,200) + '" />' : '')
    + '<input type="password" name="password" placeholder="Password" autofocus required />'
    + '<button type="submit">Unlock</button>'
    + '</form>'
    + (err ? '<p class="err">Incorrect password — please try again.</p>' : '')
    + '</div></body></html>');
});


// ── POST /api/auth ─────────────────────────────────────────────────────────────
app.post('/api/auth', express.urlencoded({ extended: false }), (req, res) => {
  try {
    const password = req.body && req.body.password ? String(req.body.password).trim() : '';
    const expected = (process.env.INVOICE_PASSWORD || '').trim();

    if (!expected || !password) {
      return res.redirect('/invoice?error=1');
    }

    let match = false;

    if (expected.startsWith('$h101$')) {
      // Hashed password — format: $h101$<saltHex>$<hashHex>
      // Uses scryptSync — fully synchronous, no callbacks, no hanging
      const parts = expected.split('$'); // ['', 'h101', saltHex, hashHex]
      const salt       = Buffer.from(parts[2], 'hex');
      const storedHash = Buffer.from(parts[3], 'hex');
      const derived    = crypto.scryptSync(password, salt, 64);
      match = crypto.timingSafeEqual(derived, storedHash);
    } else {
      // Plain text fallback — constant-time compare with fixed-size buffers
      const a = Buffer.alloc(512);
      const b = Buffer.alloc(512);
      Buffer.from(password).copy(a);
      Buffer.from(expected).copy(b);
      match = password.length === expected.length && crypto.timingSafeEqual(a, b);
    }

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
    // Redirect to original URL if provided (preserves prefill params)
    const nextRaw = req.body && req.body.next ? String(req.body.next) : '';
    const dest = (nextRaw && nextRaw.startsWith('/invoice/app')) ? nextRaw : '/invoice/app';
    return res.redirect(dest);

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
const INVOICE_HTML_B64 = 'PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9ImVuIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9IlVURi04Ij4KPG1ldGEgbmFtZT0idmlld3BvcnQiIGNvbnRlbnQ9IndpZHRoPWRldmljZS13aWR0aCwgaW5pdGlhbC1zY2FsZT0xLjAiPgo8dGl0bGU+SG9tZSAxMDEg4oCUIFNlbmQgUXVvdGU8L3RpdGxlPgo8bGluayBocmVmPSJodHRwczovL2ZvbnRzLmdvb2dsZWFwaXMuY29tL2NzczI/ZmFtaWx5PUZyYXVuY2VzOml0YWwsd2dodEAwLDcwMDswLDkwMCZmYW1pbHk9SW5zdHJ1bWVudCtTYW5zOndnaHRANDAwOzUwMDs2MDAmZGlzcGxheT1zd2FwIiByZWw9InN0eWxlc2hlZXQiPgo8c2NyaXB0IHNyYz0iaHR0cHM6Ly9jZG5qcy5jbG91ZGZsYXJlLmNvbS9hamF4L2xpYnMvanNwZGYvMi41LjEvanNwZGYudW1kLm1pbi5qcyI+PC9zY3JpcHQ+CjxzdHlsZT4KKiwgKjo6YmVmb3JlLCAqOjphZnRlciB7IGJveC1zaXppbmc6IGJvcmRlci1ib3g7IG1hcmdpbjogMDsgcGFkZGluZzogMDsgfQo6cm9vdCB7CiAgLS1iZzogI2Y3ZjRlZjsgLS1pbms6ICMxYzFjMWM7IC0tc2xhdGU6ICMzYTNhM2E7CiAgLS1nb2xkOiAjYzg5MjJhOyAtLW11dGVkOiAjODg4OyAtLWxpbmU6IHJnYmEoMjgsMjgsMjgsMC4xKTsKICAtLXdoaXRlOiAjZmZmZmZmOyAtLXN0b25lOiAjZjBlY2U0OyAtLXN1Y2Nlc3M6ICMyYTdhNTI7IC0tZXJyb3I6ICNiODMyMzI7Cn0KYm9keSB7IGZvbnQtZmFtaWx5OiAnSW5zdHJ1bWVudCBTYW5zJywgc2Fucy1zZXJpZjsgYmFja2dyb3VuZDogdmFyKC0tYmcpOyBjb2xvcjogdmFyKC0taW5rKTsgbWluLWhlaWdodDogMTAwdmg7IHBhZGRpbmc6IDQwcHggMjBweDsgfQoucGFnZSB7IG1heC13aWR0aDogNzIwcHg7IG1hcmdpbjogMCBhdXRvOyB9CgovKiBQQVNTV09SRCAqLwojbG9ja1NjcmVlbiB7IHBvc2l0aW9uOiBmaXhlZDsgaW5zZXQ6IDA7IGJhY2tncm91bmQ6IHZhcigtLWJnKTsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsganVzdGlmeS1jb250ZW50OiBjZW50ZXI7IHotaW5kZXg6IDk5OTsgfQoubG9jay1jYXJkIHsgYmFja2dyb3VuZDogdmFyKC0td2hpdGUpOyBib3JkZXItcmFkaXVzOiAyMHB4OyBwYWRkaW5nOiA0MHB4OyBib3gtc2hhZG93OiAwIDhweCA0MHB4IHJnYmEoMjgsMjgsMjgsMC4xMik7IGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWxpbmUpOyB3aWR0aDogMTAwJTsgbWF4LXdpZHRoOiAzNjBweDsgdGV4dC1hbGlnbjogY2VudGVyOyB9Ci5sb2NrLWxvZ28geyBmb250LWZhbWlseTogJ0ZyYXVuY2VzJywgc2VyaWY7IGZvbnQtc2l6ZTogMS41cmVtOyBmb250LXdlaWdodDogOTAwOyBmb250LXN0eWxlOiBpdGFsaWM7IG1hcmdpbi1ib3R0b206IDZweDsgfQoubG9jay1sb2dvIHNwYW4geyBjb2xvcjogdmFyKC0tZ29sZCk7IH0KLmxvY2stc3ViIHsgZm9udC1zaXplOiAwLjgycmVtOyBjb2xvcjogdmFyKC0tbXV0ZWQpOyBtYXJnaW4tYm90dG9tOiAyNHB4OyB9Ci5sb2NrLWNhcmQgaW5wdXQgeyB3aWR0aDogMTAwJTsgYm9yZGVyOiAxLjVweCBzb2xpZCB2YXIoLS1saW5lKTsgYm9yZGVyLXJhZGl1czogMTBweDsgcGFkZGluZzogMTJweCAxNHB4OyBmb250LXNpemU6IDAuOTVyZW07IGZvbnQtZmFtaWx5OiAnSW5zdHJ1bWVudCBTYW5zJywgc2Fucy1zZXJpZjsgYmFja2dyb3VuZDogdmFyKC0tYmcpOyBvdXRsaW5lOiBub25lOyB0ZXh0LWFsaWduOiBjZW50ZXI7IGxldHRlci1zcGFjaW5nOiAwLjE1ZW07IG1hcmdpbi1ib3R0b206IDEycHg7IHRyYW5zaXRpb246IGJvcmRlci1jb2xvciAuMnMsIGJveC1zaGFkb3cgLjJzOyB9Ci5sb2NrLWNhcmQgaW5wdXQ6Zm9jdXMgeyBib3JkZXItY29sb3I6IHZhcigtLWdvbGQpOyBib3gtc2hhZG93OiAwIDAgMCAzcHggcmdiYSgyMDAsMTQ2LDQyLDAuMTIpOyBiYWNrZ3JvdW5kOiB2YXIoLS13aGl0ZSk7IH0KLmxvY2stYnRuIHsgd2lkdGg6IDEwMCU7IGJhY2tncm91bmQ6IHZhcigtLWluayk7IGNvbG9yOiB2YXIoLS13aGl0ZSk7IGJvcmRlcjogbm9uZTsgYm9yZGVyLXJhZGl1czogMTBweDsgcGFkZGluZzogMTNweDsgZm9udC1mYW1pbHk6ICdJbnN0cnVtZW50IFNhbnMnLCBzYW5zLXNlcmlmOyBmb250LXNpemU6IDAuOTVyZW07IGZvbnQtd2VpZ2h0OiA3MDA7IGN1cnNvcjogcG9pbnRlcjsgdHJhbnNpdGlvbjogYmFja2dyb3VuZCAuMnM7IH0KLmxvY2stYnRuOmhvdmVyIHsgYmFja2dyb3VuZDogdmFyKC0tZ29sZCk7IH0KLmxvY2stZXJyb3IgeyBmb250LXNpemU6IDAuOHJlbTsgY29sb3I6IHZhcigtLWVycm9yKTsgbWFyZ2luLXRvcDogOHB4OyBkaXNwbGF5OiBub25lOyB9CgojbWFpbkNvbnRlbnQgeyBkaXNwbGF5OiBibG9jazsgfQoKLyogSEVBREVSICovCi5wYWdlLWhlYWRlciB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGp1c3RpZnktY29udGVudDogc3BhY2UtYmV0d2VlbjsgbWFyZ2luLWJvdHRvbTogMjRweDsgZmxleC13cmFwOiB3cmFwOyBnYXA6IDEwcHg7IH0KLmxvZ28geyBmb250LWZhbWlseTogJ0ZyYXVuY2VzJywgc2VyaWY7IGZvbnQtc2l6ZTogMS40cmVtOyBmb250LXdlaWdodDogOTAwOyBmb250LXN0eWxlOiBpdGFsaWM7IGNvbG9yOiB2YXIoLS1pbmspOyB9Ci5sb2dvIHNwYW4geyBjb2xvcjogdmFyKC0tZ29sZCk7IH0KLmJhZGdlIHsgYmFja2dyb3VuZDogdmFyKC0tc3RvbmUpOyBib3JkZXItcmFkaXVzOiA1MHB4OyBwYWRkaW5nOiA1cHggMTRweDsgZm9udC1zaXplOiAwLjcycmVtOyBmb250LXdlaWdodDogNzAwOyBjb2xvcjogdmFyKC0tbXV0ZWQpOyB0ZXh0LXRyYW5zZm9ybTogdXBwZXJjYXNlOyBsZXR0ZXItc3BhY2luZzogMC4wOGVtOyB9Ci5wcmVmaWxsLWJhbm5lciB7IGJhY2tncm91bmQ6IHJnYmEoMjAwLDE0Niw0MiwwLjEpOyBib3JkZXI6IDFweCBzb2xpZCByZ2JhKDIwMCwxNDYsNDIsMC4zKTsgYm9yZGVyLXJhZGl1czogMTBweDsgcGFkZGluZzogMTJweCAxOHB4OyBtYXJnaW4tYm90dG9tOiAyMHB4OyBmb250LXNpemU6IDAuODNyZW07IGNvbG9yOiB2YXIoLS1zbGF0ZSk7IGRpc3BsYXk6IG5vbmU7IH0KLnByZWZpbGwtYmFubmVyIHN0cm9uZyB7IGNvbG9yOiB2YXIoLS1nb2xkKTsgfQoKLyogQ0FSRCAqLwouY2FyZCB7IGJhY2tncm91bmQ6IHZhcigtLXdoaXRlKTsgYm9yZGVyLXJhZGl1czogMjBweDsgcGFkZGluZzogMzJweDsgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tbGluZSk7IGJveC1zaGFkb3c6IDAgNHB4IDIwcHggcmdiYSgyOCwyOCwyOCwwLjA2KTsgbWFyZ2luLWJvdHRvbTogMTZweDsgfQouY2FyZC10aXRsZSB7IGZvbnQtZmFtaWx5OiAnRnJhdW5jZXMnLCBzZXJpZjsgZm9udC1zaXplOiAxLjFyZW07IGZvbnQtd2VpZ2h0OiA5MDA7IG1hcmdpbi1ib3R0b206IDE4cHg7IHBhZGRpbmctYm90dG9tOiAxNHB4OyBib3JkZXItYm90dG9tOiAxcHggc29saWQgdmFyKC0tbGluZSk7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogOHB4OyB9Ci5jYXJkLXRpdGxlIHN2ZyB7IGNvbG9yOiB2YXIoLS1nb2xkKTsgfQoKLyogRklFTERTICovCi5maWVsZCB7IG1hcmdpbi1ib3R0b206IDE0cHg7IH0KLmZpZWxkIGxhYmVsIHsgZGlzcGxheTogYmxvY2s7IGZvbnQtc2l6ZTogMC43MnJlbTsgZm9udC13ZWlnaHQ6IDcwMDsgdGV4dC10cmFuc2Zvcm06IHVwcGVyY2FzZTsgbGV0dGVyLXNwYWNpbmc6IDAuMDhlbTsgY29sb3I6IHZhcigtLXNsYXRlKTsgbWFyZ2luLWJvdHRvbTogNnB4OyB9Ci5maWVsZCBpbnB1dCwgLmZpZWxkIHRleHRhcmVhIHsgd2lkdGg6IDEwMCU7IGJvcmRlcjogMS41cHggc29saWQgdmFyKC0tbGluZSk7IGJvcmRlci1yYWRpdXM6IDEwcHg7IHBhZGRpbmc6IDExcHggMTRweDsgZm9udC1mYW1pbHk6ICdJbnN0cnVtZW50IFNhbnMnLCBzYW5zLXNlcmlmOyBmb250LXNpemU6IDAuOTJyZW07IGNvbG9yOiB2YXIoLS1pbmspOyBiYWNrZ3JvdW5kOiB2YXIoLS1iZyk7IG91dGxpbmU6IG5vbmU7IHRyYW5zaXRpb246IGJvcmRlci1jb2xvciAuMnMsIGJveC1zaGFkb3cgLjJzOyB9Ci5maWVsZCBpbnB1dDpmb2N1cywgLmZpZWxkIHRleHRhcmVhOmZvY3VzIHsgYm9yZGVyLWNvbG9yOiB2YXIoLS1nb2xkKTsgYm94LXNoYWRvdzogMCAwIDAgM3B4IHJnYmEoMjAwLDE0Niw0MiwwLjEyKTsgYmFja2dyb3VuZDogdmFyKC0td2hpdGUpOyB9Ci5maWVsZCB0ZXh0YXJlYSB7IHJlc2l6ZTogdmVydGljYWw7IG1pbi1oZWlnaHQ6IDgwcHg7IGxpbmUtaGVpZ2h0OiAxLjY7IH0KLmZpZWxkLXJvdyB7IGRpc3BsYXk6IGZsZXg7IGdhcDogMTJweDsgfQouZmllbGQtcm93IC5maWVsZCB7IGZsZXg6IDE7IH0KLmZpZWxkLWhpbnQgeyBmb250LXNpemU6IDAuNzNyZW07IGNvbG9yOiB2YXIoLS1tdXRlZCk7IG1hcmdpbi10b3A6IDVweDsgbGluZS1oZWlnaHQ6IDEuNTsgfQoKLyogTElORSBJVEVNUyAqLwoubGluZS1pdGVtIHsgZGlzcGxheTogZmxleDsgZ2FwOiA4cHg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IG1hcmdpbi1ib3R0b206IDhweDsgfQoubGluZS1pdGVtIGlucHV0OmZpcnN0LWNoaWxkIHsgZmxleDogMTsgfQoubGluZS1pdGVtIGlucHV0LmFtdCB7IHdpZHRoOiAxMTBweDsgZmxleC1zaHJpbms6IDA7IH0KLmxpbmUtaXRlbS1yZW1vdmUgeyB3aWR0aDogMjhweDsgaGVpZ2h0OiAyOHB4OyBib3JkZXItcmFkaXVzOiA1MCU7IGJhY2tncm91bmQ6IHZhcigtLXN0b25lKTsgYm9yZGVyOiBub25lOyBjdXJzb3I6IHBvaW50ZXI7IGZvbnQtc2l6ZTogMC43NXJlbTsgY29sb3I6IHZhcigtLW11dGVkKTsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsganVzdGlmeS1jb250ZW50OiBjZW50ZXI7IGZsZXgtc2hyaW5rOiAwOyB0cmFuc2l0aW9uOiBhbGwgLjJzOyB9Ci5saW5lLWl0ZW0tcmVtb3ZlOmhvdmVyIHsgYmFja2dyb3VuZDogcmdiYSgxODQsNTAsNTAsMC4xMik7IGNvbG9yOiB2YXIoLS1lcnJvcik7IH0KLmFkZC1saW5lLWJ0biB7IGJhY2tncm91bmQ6IHRyYW5zcGFyZW50OyBib3JkZXI6IDEuNXB4IGRhc2hlZCB2YXIoLS1saW5lKTsgYm9yZGVyLXJhZGl1czogOHB4OyBwYWRkaW5nOiA4cHggMTZweDsgZm9udC1mYW1pbHk6ICdJbnN0cnVtZW50IFNhbnMnLCBzYW5zLXNlcmlmOyBmb250LXNpemU6IDAuODJyZW07IGNvbG9yOiB2YXIoLS1tdXRlZCk7IGN1cnNvcjogcG9pbnRlcjsgd2lkdGg6IDEwMCU7IHRyYW5zaXRpb246IGFsbCAuMnM7IG1hcmdpbi10b3A6IDRweDsgfQouYWRkLWxpbmUtYnRuOmhvdmVyIHsgYm9yZGVyLWNvbG9yOiB2YXIoLS1nb2xkKTsgY29sb3I6IHZhcigtLWdvbGQpOyB9Ci50b3RhbC1yb3cgeyBkaXNwbGF5OiBmbGV4OyBqdXN0aWZ5LWNvbnRlbnQ6IHNwYWNlLWJldHdlZW47IGFsaWduLWl0ZW1zOiBjZW50ZXI7IHBhZGRpbmc6IDE0cHggMCA0cHg7IGJvcmRlci10b3A6IDJweCBzb2xpZCB2YXIoLS1pbmspOyBtYXJnaW4tdG9wOiAxMHB4OyB9Ci50b3RhbC1yb3cgc3BhbjpmaXJzdC1jaGlsZCB7IGZvbnQtd2VpZ2h0OiA3MDA7IH0KLnRvdGFsLWFtb3VudCB7IGZvbnQtZmFtaWx5OiAnRnJhdW5jZXMnLCBzZXJpZjsgZm9udC1zaXplOiAxLjZyZW07IGZvbnQtd2VpZ2h0OiA5MDA7IGNvbG9yOiB2YXIoLS1nb2xkKTsgfQoKLyogU1RSSVBFIEhFTFBFUiAqLwouc3RyaXBlLWhlbHBlciB7IGJhY2tncm91bmQ6IHJnYmEoOTksOTEsMjU1LDAuMDUpOyBib3JkZXI6IDFweCBzb2xpZCByZ2JhKDk5LDkxLDI1NSwwLjE1KTsgYm9yZGVyLXJhZGl1czogMTJweDsgcGFkZGluZzogMTZweCAxOHB4OyBtYXJnaW4tYm90dG9tOiAxNHB4OyB9Ci5zdHJpcGUtaGVscGVyLXRpdGxlIHsgZm9udC1zaXplOiAwLjc1cmVtOyBmb250LXdlaWdodDogNzAwOyB0ZXh0LXRyYW5zZm9ybTogdXBwZXJjYXNlOyBsZXR0ZXItc3BhY2luZzogMC4wOGVtOyBjb2xvcjogIzYzNTZmZjsgbWFyZ2luLWJvdHRvbTogMTBweDsgfQouc3RyaXBlLXN0ZXBzIHsgZm9udC1zaXplOiAwLjgycmVtOyBjb2xvcjogdmFyKC0tc2xhdGUpOyBsaW5lLWhlaWdodDogMS45OyBtYXJnaW4tYm90dG9tOiAxMnB4OyB9Ci5zdHJpcGUtc3RlcHMgc3Ryb25nIHsgY29sb3I6IHZhcigtLWluayk7IH0KLnN0cmlwZS1hbXQgeyBkaXNwbGF5OiBpbmxpbmUtYmxvY2s7IGJhY2tncm91bmQ6IHJnYmEoOTksOTEsMjU1LDAuMSk7IGJvcmRlci1yYWRpdXM6IDZweDsgcGFkZGluZzogMXB4IDlweDsgZm9udC13ZWlnaHQ6IDcwMDsgY29sb3I6ICM2MzU2ZmY7IGZvbnQtc2l6ZTogMC44MnJlbTsgfQouc3RyaXBlLW9wZW4tYnRuIHsgZGlzcGxheTogaW5saW5lLWZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogN3B4OyBiYWNrZ3JvdW5kOiAjNjM1NmZmOyBjb2xvcjogd2hpdGU7IGJvcmRlcjogbm9uZTsgYm9yZGVyLXJhZGl1czogOHB4OyBwYWRkaW5nOiA5cHggMThweDsgZm9udC1mYW1pbHk6ICdJbnN0cnVtZW50IFNhbnMnLCBzYW5zLXNlcmlmOyBmb250LXNpemU6IDAuODJyZW07IGZvbnQtd2VpZ2h0OiA3MDA7IGN1cnNvcjogcG9pbnRlcjsgdGV4dC1kZWNvcmF0aW9uOiBub25lOyB0cmFuc2l0aW9uOiBiYWNrZ3JvdW5kIC4yczsgfQouc3RyaXBlLW9wZW4tYnRuOmhvdmVyIHsgYmFja2dyb3VuZDogIzRmNDNlMDsgfQoKLyogQlVUVE9OUyAqLwouYWN0aW9uLXJvdyB7IGRpc3BsYXk6IGZsZXg7IGdhcDogMTBweDsgbWFyZ2luLXRvcDogMjBweDsgZmxleC13cmFwOiB3cmFwOyB9Ci5idG4tcHJpbWFyeSB7IGZsZXg6IDI7IG1pbi13aWR0aDogMjAwcHg7IGJhY2tncm91bmQ6IHZhcigtLWluayk7IGNvbG9yOiB2YXIoLS13aGl0ZSk7IGJvcmRlcjogbm9uZTsgYm9yZGVyLXJhZGl1czogMTBweDsgcGFkZGluZzogMTRweDsgZm9udC1mYW1pbHk6ICdJbnN0cnVtZW50IFNhbnMnLCBzYW5zLXNlcmlmOyBmb250LXNpemU6IDAuOTVyZW07IGZvbnQtd2VpZ2h0OiA3MDA7IGN1cnNvcjogcG9pbnRlcjsgdHJhbnNpdGlvbjogYmFja2dyb3VuZCAuMnM7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGp1c3RpZnktY29udGVudDogY2VudGVyOyBnYXA6IDhweDsgfQouYnRuLXByaW1hcnk6aG92ZXIgeyBiYWNrZ3JvdW5kOiB2YXIoLS1nb2xkKTsgfQouYnRuLXByaW1hcnk6ZGlzYWJsZWQgeyBvcGFjaXR5OiAwLjU7IGN1cnNvcjogbm90LWFsbG93ZWQ7IH0KLmJ0bi1zZWNvbmRhcnkgeyBmbGV4OiAxOyBtaW4td2lkdGg6IDE0MHB4OyBiYWNrZ3JvdW5kOiB0cmFuc3BhcmVudDsgY29sb3I6IHZhcigtLWluayk7IGJvcmRlcjogMS41cHggc29saWQgdmFyKC0tbGluZSk7IGJvcmRlci1yYWRpdXM6IDEwcHg7IHBhZGRpbmc6IDE0cHg7IGZvbnQtZmFtaWx5OiAnSW5zdHJ1bWVudCBTYW5zJywgc2Fucy1zZXJpZjsgZm9udC1zaXplOiAwLjlyZW07IGZvbnQtd2VpZ2h0OiA2MDA7IGN1cnNvcjogcG9pbnRlcjsgdHJhbnNpdGlvbjogYWxsIC4yczsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsganVzdGlmeS1jb250ZW50OiBjZW50ZXI7IGdhcDogN3B4OyB9Ci5idG4tc2Vjb25kYXJ5OmhvdmVyIHsgYm9yZGVyLWNvbG9yOiB2YXIoLS1pbmspOyBiYWNrZ3JvdW5kOiB2YXIoLS1zdG9uZSk7IH0KLnNwaW5uZXIgeyB3aWR0aDogMTZweDsgaGVpZ2h0OiAxNnB4OyBib3JkZXI6IDIuNXB4IHNvbGlkIHJnYmEoMjU1LDI1NSwyNTUsMC4zKTsgYm9yZGVyLXRvcC1jb2xvcjogd2hpdGU7IGJvcmRlci1yYWRpdXM6IDUwJTsgYW5pbWF0aW9uOiBzcGluIC43cyBsaW5lYXIgaW5maW5pdGU7IGRpc3BsYXk6IG5vbmU7IH0KQGtleWZyYW1lcyBzcGluIHsgdG8geyB0cmFuc2Zvcm06IHJvdGF0ZSgzNjBkZWcpOyB9IH0KLnN0YXR1cy1tc2cgeyBib3JkZXItcmFkaXVzOiAxMHB4OyBwYWRkaW5nOiAxM3B4IDE4cHg7IGZvbnQtc2l6ZTogMC44NXJlbTsgZm9udC13ZWlnaHQ6IDYwMDsgbWFyZ2luLXRvcDogMTJweDsgZGlzcGxheTogbm9uZTsgbGluZS1oZWlnaHQ6IDEuNTsgfQouc3RhdHVzLW1zZy5zdWNjZXNzIHsgYmFja2dyb3VuZDogcmdiYSg0MiwxMjIsODIsMC4wOCk7IGJvcmRlcjogMXB4IHNvbGlkIHJnYmEoNDIsMTIyLDgyLDAuMjUpOyBjb2xvcjogdmFyKC0tc3VjY2Vzcyk7IH0KLnN0YXR1cy1tc2cuZXJyb3IgeyBiYWNrZ3JvdW5kOiByZ2JhKDE4NCw1MCw1MCwwLjA3KTsgYm9yZGVyOiAxcHggc29saWQgcmdiYSgxODQsNTAsNTAsMC4yKTsgY29sb3I6IHZhcigtLWVycm9yKTsgfQoKLyogUFJFVklFVyAqLwoucHJldmlldy1sYWJlbCB7IGZvbnQtc2l6ZTogMC43MnJlbTsgZm9udC13ZWlnaHQ6IDcwMDsgdGV4dC10cmFuc2Zvcm06IHVwcGVyY2FzZTsgbGV0dGVyLXNwYWNpbmc6IDAuMDhlbTsgY29sb3I6IHZhcigtLW11dGVkKTsgbWFyZ2luLWJvdHRvbTogMTBweDsgbWFyZ2luLXRvcDogOHB4OyB9Ci5wcmV2aWV3LWNhcmQgeyBiYWNrZ3JvdW5kOiB2YXIoLS13aGl0ZSk7IGJvcmRlci1yYWRpdXM6IDE0cHg7IG92ZXJmbG93OiBoaWRkZW47IGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWxpbmUpOyBmb250LXNpemU6IDEzcHg7IGJveC1zaGFkb3c6IDAgNHB4IDIwcHggcmdiYSgyOCwyOCwyOCwwLjA2KTsgfQoucC1oZWFkZXIgeyBiYWNrZ3JvdW5kOiB2YXIoLS1pbmspOyBwYWRkaW5nOiAxNnB4IDIycHg7IH0KLnAtbG9nbyB7IGZvbnQtd2VpZ2h0OiA5MDA7IGNvbG9yOiB3aGl0ZTsgZm9udC1zdHlsZTogaXRhbGljOyBmb250LXNpemU6IDE2cHg7IH0KLnAtc3ViIHsgY29sb3I6IHJnYmEoMjU1LDI1NSwyNTUsMC40KTsgZm9udC1zaXplOiAxMXB4OyBtYXJnaW4tdG9wOiAzcHg7IH0KLnAtYmFyIHsgYmFja2dyb3VuZDogdmFyKC0tZ29sZCk7IHBhZGRpbmc6IDEwcHggMjJweDsgZGlzcGxheTogZmxleDsganVzdGlmeS1jb250ZW50OiBzcGFjZS1iZXR3ZWVuOyBhbGlnbi1pdGVtczogY2VudGVyOyB9Ci5wLWJhciBzcGFuIHsgY29sb3I6IHdoaXRlOyBmb250LXdlaWdodDogNzAwOyBmb250LXNpemU6IDEycHg7IH0KLnAtYm9keSB7IHBhZGRpbmc6IDIwcHggMjJweDsgfQoucC1tZXRhIHsgZGlzcGxheTogZmxleDsgZ2FwOiAxNnB4OyBmbGV4LXdyYXA6IHdyYXA7IG1hcmdpbi1ib3R0b206IDE0cHg7IH0KLnAtbWV0YS1pdGVtIHsgZm9udC1zaXplOiAxMXB4OyB9Ci5wLW1ldGEtbGFiZWwgeyBjb2xvcjogdmFyKC0tbXV0ZWQpOyBmb250LXdlaWdodDogNzAwOyB0ZXh0LXRyYW5zZm9ybTogdXBwZXJjYXNlOyBsZXR0ZXItc3BhY2luZzogMC4wNmVtOyBkaXNwbGF5OiBibG9jazsgbWFyZ2luLWJvdHRvbTogMnB4OyBmb250LXNpemU6IDEwcHg7IH0KLnAtbWV0YS12YWwgeyBjb2xvcjogdmFyKC0taW5rKTsgZm9udC13ZWlnaHQ6IDYwMDsgfQoucC1kZXNjIHsgYmFja2dyb3VuZDogdmFyKC0tc3RvbmUpOyBib3JkZXItbGVmdDogM3B4IHNvbGlkIHZhcigtLWdvbGQpOyBwYWRkaW5nOiAxMHB4IDE0cHg7IGJvcmRlci1yYWRpdXM6IDAgOHB4IDhweCAwOyBmb250LXNpemU6IDEycHg7IGNvbG9yOiB2YXIoLS1zbGF0ZSk7IG1hcmdpbi1ib3R0b206IDE0cHg7IGxpbmUtaGVpZ2h0OiAxLjY1OyB3aGl0ZS1zcGFjZTogcHJlLXdyYXA7IHdvcmQtYnJlYWs6IGJyZWFrLXdvcmQ7IH0KLnAtbGluZXMgeyB3aWR0aDogMTAwJTsgYm9yZGVyLWNvbGxhcHNlOiBjb2xsYXBzZTsgZm9udC1zaXplOiAxMnB4OyBtYXJnaW4tYm90dG9tOiAxMHB4OyB9Ci5wLWxpbmVzIHRkIHsgcGFkZGluZzogNnB4IDA7IGJvcmRlci1ib3R0b206IDFweCBzb2xpZCB2YXIoLS1saW5lKTsgY29sb3I6IHZhcigtLXNsYXRlKTsgfQoucC1saW5lcyB0ZDpsYXN0LWNoaWxkIHsgdGV4dC1hbGlnbjogcmlnaHQ7IGZvbnQtd2VpZ2h0OiA2MDA7IHdoaXRlLXNwYWNlOiBub3dyYXA7IH0KLnAtdG90YWwtcm93IHsgZGlzcGxheTogZmxleDsganVzdGlmeS1jb250ZW50OiBzcGFjZS1iZXR3ZWVuOyBhbGlnbi1pdGVtczogY2VudGVyOyBwYWRkaW5nOiAxMHB4IDAgMTRweDsgfQoucC10b3RhbC1sYWJlbCB7IGZvbnQtd2VpZ2h0OiA3MDA7IGZvbnQtc2l6ZTogMTNweDsgfQoucC10b3RhbC1hbXQgeyBmb250LWZhbWlseTogJ0ZyYXVuY2VzJywgc2VyaWY7IGZvbnQtc2l6ZTogMS4zcmVtOyBmb250LXdlaWdodDogOTAwOyBjb2xvcjogdmFyKC0tZ29sZCk7IH0KLnAtcGF5LWJ0biB7IGRpc3BsYXk6IGJsb2NrOyBiYWNrZ3JvdW5kOiB2YXIoLS1pbmspOyBjb2xvcjogd2hpdGU7IHRleHQtYWxpZ246IGNlbnRlcjsgcGFkZGluZzogMTFweDsgYm9yZGVyLXJhZGl1czogOHB4OyBmb250LXdlaWdodDogNzAwOyBmb250LXNpemU6IDEzcHg7IHRleHQtZGVjb3JhdGlvbjogbm9uZTsgbWFyZ2luLWJvdHRvbTogNHB4OyB9Ci5wLW5vdGVzIHsgYmFja2dyb3VuZDogdmFyKC0tc3RvbmUpOyBib3JkZXItcmFkaXVzOiA4cHg7IHBhZGRpbmc6IDEwcHggMTRweDsgZm9udC1zaXplOiAxMXB4OyBjb2xvcjogdmFyKC0tbXV0ZWQpOyBsaW5lLWhlaWdodDogMS42OyBtYXJnaW4tdG9wOiAxMHB4OyBkaXNwbGF5OiBub25lOyB3aGl0ZS1zcGFjZTogcHJlLXdyYXA7IH0KLnAtZHVlLWxpbmUgeyBmb250LXNpemU6IDExcHg7IGNvbG9yOiB2YXIoLS1tdXRlZCk7IHRleHQtYWxpZ246IGNlbnRlcjsgbWFyZ2luLXRvcDogNnB4OyBkaXNwbGF5OiBub25lOyB9CgpAbWVkaWEobWF4LXdpZHRoOjYwMHB4KSB7IC5maWVsZC1yb3cgeyBmbGV4LWRpcmVjdGlvbjogY29sdW1uOyBnYXA6IDA7IH0gLmNhcmQgeyBwYWRkaW5nOiAyMnB4OyB9IC5hY3Rpb24tcm93IHsgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsgfSAuYnRuLXByaW1hcnksIC5idG4tc2Vjb25kYXJ5IHsgZmxleDogbm9uZTsgd2lkdGg6IDEwMCU7IH0gfQo8L3N0eWxlPgo8L2hlYWQ+Cjxib2R5PgoKPGRpdiBpZD0ibWFpbkNvbnRlbnQiPgo8ZGl2IGNsYXNzPSJwYWdlIj4KCiAgPGRpdiBjbGFzcz0icGFnZS1oZWFkZXIiPgogICAgPGRpdiBjbGFzcz0ibG9nbyI+SG9tZTxzcGFuPiAxMDE8L3NwYW4+PC9kaXY+CiAgICA8c3BhbiBjbGFzcz0iYmFkZ2UiPkludGVybmFsIOKAlCBTZW5kIFF1b3RlPC9zcGFuPgogICAgPGRpdiBzdHlsZT0iZGlzcGxheTpmbGV4O2dhcDo4cHg7Ij4KICAgIDxidXR0b24gb25jbGljaz0iY2xlYXJGb3JtKCkiIHN0eWxlPSJiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O2JvcmRlcjoxLjVweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjhweDtwYWRkaW5nOjZweCAxNHB4O2ZvbnQtc2l6ZTowLjc4cmVtO2ZvbnQtd2VpZ2h0OjYwMDtjb2xvcjp2YXIoLS1tdXRlZCk7Y3Vyc29yOnBvaW50ZXI7Zm9udC1mYW1pbHk6J0luc3RydW1lbnQgU2Fucycsc2Fucy1zZXJpZjsiPkNsZWFyIGZvcm08L2J1dHRvbj4KICAgIDxidXR0b24gb25jbGljaz0iZmV0Y2goJy9hcGkvbG9nb3V0Jyx7bWV0aG9kOidQT1NUJyxjcmVkZW50aWFsczonaW5jbHVkZSd9KS50aGVuKCgpPT57d2luZG93LmxvY2F0aW9uLmhyZWY9Jy9pbnZvaWNlJ30pIiBzdHlsZT0iYmFja2dyb3VuZDp0cmFuc3BhcmVudDtib3JkZXI6MS41cHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czo4cHg7cGFkZGluZzo2cHggMTRweDtmb250LXNpemU6MC43OHJlbTtmb250LXdlaWdodDo2MDA7Y29sb3I6dmFyKC0tbXV0ZWQpO2N1cnNvcjpwb2ludGVyO2ZvbnQtZmFtaWx5OidJbnN0cnVtZW50IFNhbnMnLHNhbnMtc2VyaWY7Ij5Mb2cgb3V0PC9idXR0b24+CiAgPC9kaXY+CiAgPC9kaXY+CiAgPGRpdiBjbGFzcz0icHJlZmlsbC1iYW5uZXIiIGlkPSJwcmVmaWxsQmFubmVyIj48L2Rpdj4KCiAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICA8ZGl2IGNsYXNzPSJjYXJkLXRpdGxlIj4KICAgICAgPHN2ZyB3aWR0aD0iMTYiIGhlaWdodD0iMTYiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMjAgMjF2LTJhNCA0IDAgMCAwLTQtNEg4YTQgNCAwIDAgMC00IDR2MiIvPjxjaXJjbGUgY3g9IjEyIiBjeT0iNyIgcj0iNCIvPjwvc3ZnPgogICAgICBDdXN0b21lciBEZXRhaWxzCiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImZpZWxkLXJvdyI+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+RnVsbCBOYW1lPC9sYWJlbD48aW5wdXQgdHlwZT0idGV4dCIgaWQ9ImN1c3RvbWVyTmFtZSIgcGxhY2Vob2xkZXI9IkphbmUgU21pdGgiIG9uaW5wdXQ9InVwZGF0ZVByZXZpZXcoKSIgLz48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5QaG9uZTwvbGFiZWw+PGlucHV0IHR5cGU9InRlbCIgaWQ9ImN1c3RvbWVyUGhvbmUiIHBsYWNlaG9sZGVyPSIoNDAzKSA1NTUtMDE5MiIgb25pbnB1dD0idXBkYXRlUHJldmlldygpIiAvPjwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkVtYWlsIEFkZHJlc3M8L2xhYmVsPjxpbnB1dCB0eXBlPSJlbWFpbCIgaWQ9ImN1c3RvbWVyRW1haWwiIHBsYWNlaG9sZGVyPSJqYW5lQGV4YW1wbGUuY29tIiBvbmlucHV0PSJ1cGRhdGVQcmV2aWV3KCkiIC8+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlNlcnZpY2UgQWRkcmVzczwvbGFiZWw+PGlucHV0IHR5cGU9InRleHQiIGlkPSJhZGRyZXNzIiBwbGFjZWhvbGRlcj0iNDIgTWFwbGUgU3RyZWV0LCBDYWxnYXJ5LCBBQiIgb25pbnB1dD0idXBkYXRlUHJldmlldygpIiAvPjwvZGl2PgogIDwvZGl2PgoKICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgIDxkaXYgY2xhc3M9ImNhcmQtdGl0bGUiPgogICAgICA8c3ZnIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxwYXRoIGQ9Ik0xNC43IDYuM2ExIDEgMCAwIDAgMCAxLjRsMS42IDEuNmExIDEgMCAwIDAgMS40IDBsMy43Ny0zLjc3YTYgNiAwIDAgMS03Ljk0IDcuOTRsLTYuOTEgNi45MWEyLjEyIDIuMTIgMCAwIDEtMy0zbDYuOTEtNi45MWE2IDYgMCAwIDEgNy45NC03Ljk0bC0zLjc2IDMuNzZ6Ii8+PC9zdmc+CiAgICAgIEpvYiBEZXRhaWxzCiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+V29yayBEZXNjcmlwdGlvbjwvbGFiZWw+PHRleHRhcmVhIGlkPSJqb2JEZXNjcmlwdGlvbiIgcGxhY2Vob2xkZXI9ImUuZy4gUmVwbGFjZSBraXRjaGVuIHRhcCBhbmQgcmVwYWlyIGNvcnJvZGVkIHBpcGUgdW5kZXIgc2luay4gTGFib3VyIGFuZCBtYXRlcmlhbHMgaW5jbHVkZWQuIiBvbmlucHV0PSJ1cGRhdGVQcmV2aWV3KCkiPjwvdGV4dGFyZWE+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+CiAgICAgIDxsYWJlbD5RdW90ZSBCcmVha2Rvd248L2xhYmVsPgogICAgICA8ZGl2IGlkPSJsaW5lSXRlbXMiPjwvZGl2PgogICAgICA8YnV0dG9uIGNsYXNzPSJhZGQtbGluZS1idG4iIG9uY2xpY2s9ImFkZExpbmVJdGVtKCkiPisgQWRkIGxpbmUgaXRlbTwvYnV0dG9uPgogICAgICA8ZGl2IGNsYXNzPSJ0b3RhbC1yb3ciPjxzcGFuPlRvdGFsIChDQUQpPC9zcGFuPjxzcGFuIGNsYXNzPSJ0b3RhbC1hbW91bnQiIGlkPSJ0b3RhbERpc3BsYXkiPiQwLjAwPC9zcGFuPjwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJmaWVsZC1yb3ciPgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkR1ZSBEYXRlIDxzcGFuIHN0eWxlPSJmb250LXdlaWdodDo0MDA7dGV4dC10cmFuc2Zvcm06bm9uZTsiPihvcHRpb25hbCk8L3NwYW4+PC9sYWJlbD48aW5wdXQgdHlwZT0idGV4dCIgaWQ9ImR1ZURhdGUiIHBsYWNlaG9sZGVyPSJlLmcuIEFwcmlsIDUsIDIwMjYiIG9uaW5wdXQ9InVwZGF0ZVByZXZpZXcoKSIgLz48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5SZWZlcmVuY2UgIyA8c3BhbiBzdHlsZT0iZm9udC13ZWlnaHQ6NDAwO3RleHQtdHJhbnNmb3JtOm5vbmU7Ij4ob3B0aW9uYWwpPC9zcGFuPjwvbGFiZWw+PGlucHV0IHR5cGU9InRleHQiIGlkPSJyZWZlcmVuY2UiIHBsYWNlaG9sZGVyPSJBdXRvLWdlbmVyYXRlZCBpZiBibGFuayIgb25pbnB1dD0idXBkYXRlUHJldmlldygpIiAvPjwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPk5vdGVzIDxzcGFuIHN0eWxlPSJmb250LXdlaWdodDo0MDA7dGV4dC10cmFuc2Zvcm06bm9uZTsiPihvcHRpb25hbCk8L3NwYW4+PC9sYWJlbD48dGV4dGFyZWEgaWQ9Im5vdGVzIiByb3dzPSIyIiBwbGFjZWhvbGRlcj0iZS5nLiBQcmljZSB2YWxpZCBmb3IgMTQgZGF5cy4gRXhjbHVkZXMgZGFtYWdlIGZvdW5kIGR1cmluZyByZXBhaXIuIiBvbmlucHV0PSJ1cGRhdGVQcmV2aWV3KCkiPjwvdGV4dGFyZWE+PC9kaXY+CiAgPC9kaXY+CgogIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgPGRpdiBjbGFzcz0iY2FyZC10aXRsZSI+CiAgICAgIDxzdmcgd2lkdGg9IjE2IiBoZWlnaHQ9IjE2IiB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHJlY3QgeD0iMSIgeT0iNCIgd2lkdGg9IjIyIiBoZWlnaHQ9IjE2IiByeD0iMiIgcnk9IjIiLz48bGluZSB4MT0iMSIgeTE9IjEwIiB4Mj0iMjMiIHkyPSIxMCIvPjwvc3ZnPgogICAgICBQYXltZW50CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9InN0cmlwZS1oZWxwZXIiPgogICAgICA8ZGl2IGNsYXNzPSJzdHJpcGUtaGVscGVyLXRpdGxlIj5RdWljayBTdHJpcGUgUGF5bWVudCBMaW5rPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InN0cmlwZS1zdGVwcyI+CiAgICAgICAgMS4gQ2xpY2sgPHN0cm9uZz5PcGVuIFN0cmlwZTwvc3Ryb25nPiBiZWxvdyDigJQgZ29lcyB0byB5b3VyIFBheW1lbnQgTGlua3MgZGFzaGJvYXJkPGJyPgogICAgICAgIDIuIENsaWNrIDxzdHJvbmc+Q3JlYXRlIGxpbms8L3N0cm9uZz4sIHNldCBhbW91bnQgdG8gPHNwYW4gY2xhc3M9InN0cmlwZS1hbXQiIGlkPSJzdHJpcGVBbW91bnRIaW50Ij4kMC4wMDwvc3Bhbj4gYW5kIGFkZCBhIGRlc2NyaXB0aW9uPGJyPgogICAgICAgIDMuIENvcHkgdGhlIGxpbmsgKHN0YXJ0cyB3aXRoIDxjb2RlIHN0eWxlPSJiYWNrZ3JvdW5kOnJnYmEoMCwwLDAsMC4wNik7cGFkZGluZzoxcHggNXB4O2JvcmRlci1yYWRpdXM6NHB4OyI+YnV5LnN0cmlwZS5jb20vLi4uPC9jb2RlPikgYW5kIHBhc3RlIGJlbG93CiAgICAgIDwvZGl2PgogICAgICA8YSBocmVmPSJodHRwczovL2Rhc2hib2FyZC5zdHJpcGUuY29tL3BheW1lbnQtbGlua3MiIHRhcmdldD0iX2JsYW5rIiBjbGFzcz0ic3RyaXBlLW9wZW4tYnRuIj4KICAgICAgICA8c3ZnIHdpZHRoPSIxMyIgaGVpZ2h0PSIxMyIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyLjUiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHBhdGggZD0iTTE4IDEzdjZhMiAyIDAgMCAxLTIgMkg1YTIgMiAwIDAgMS0yLTJWOGEyIDIgMCAwIDEgMi0yaDYiLz48cG9seWxpbmUgcG9pbnRzPSIxNSAzIDIxIDMgMjEgOSIvPjxsaW5lIHgxPSIxMCIgeTE9IjE0IiB4Mj0iMjEiIHkyPSIzIi8+PC9zdmc+CiAgICAgICAgT3BlbiBTdHJpcGUgRGFzaGJvYXJkCiAgICAgIDwvYT4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0iZmllbGQiPgogICAgICA8bGFiZWw+U3RyaXBlIFBheW1lbnQgTGluazwvbGFiZWw+CiAgICAgIDxpbnB1dCB0eXBlPSJ1cmwiIGlkPSJzdHJpcGVQYXltZW50TGluayIgcGxhY2Vob2xkZXI9Imh0dHBzOi8vYnV5LnN0cmlwZS5jb20veHh4eHh4eHgiIG9uaW5wdXQ9InVwZGF0ZVByZXZpZXcoKSIgLz4KICAgICAgPHAgY2xhc3M9ImZpZWxkLWhpbnQiPlBhc3RlIHRoZSBsaW5rIGdlbmVyYXRlZCBmcm9tIFN0cmlwZSBhYm92ZS48L3A+CiAgICA8L2Rpdj4KICA8L2Rpdj4KCiAgPHAgY2xhc3M9InByZXZpZXctbGFiZWwiPkxpdmUgRW1haWwgUHJldmlldzwvcD4KICA8ZGl2IGNsYXNzPSJwcmV2aWV3LWNhcmQiPgogICAgPGRpdiBjbGFzcz0icC1oZWFkZXIiPgogICAgICA8ZGl2IGNsYXNzPSJwLWxvZ28iPkhvbWUgMTAxPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InAtc3ViIj5RdW90ZSAmYW1wOyBQYXltZW50IOKAlCA8c3BhbiBpZD0icC1kYXRlIj48L3NwYW4+PC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9InAtYmFyIj4KICAgICAgPHNwYW4gaWQ9InAtcmVmIj5SRUY6IOKAlDwvc3Bhbj4KICAgICAgPHNwYW4+UXVvdGU8L3NwYW4+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9InAtYm9keSI+CiAgICAgIDxkaXYgY2xhc3M9InAtbWV0YSI+CiAgICAgICAgPGRpdiBjbGFzcz0icC1tZXRhLWl0ZW0iPjxzcGFuIGNsYXNzPSJwLW1ldGEtbGFiZWwiPlRvPC9zcGFuPjxzcGFuIGNsYXNzPSJwLW1ldGEtdmFsIiBpZD0icC1uYW1lIj7igJQ8L3NwYW4+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0icC1tZXRhLWl0ZW0iPjxzcGFuIGNsYXNzPSJwLW1ldGEtbGFiZWwiPkVtYWlsPC9zcGFuPjxzcGFuIGNsYXNzPSJwLW1ldGEtdmFsIiBpZD0icC1lbWFpbCI+4oCUPC9zcGFuPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InAtbWV0YS1pdGVtIj48c3BhbiBjbGFzcz0icC1tZXRhLWxhYmVsIj5QaG9uZTwvc3Bhbj48c3BhbiBjbGFzcz0icC1tZXRhLXZhbCIgaWQ9InAtcGhvbmUiPuKAlDwvc3Bhbj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJwLW1ldGEtaXRlbSI+PHNwYW4gY2xhc3M9InAtbWV0YS1sYWJlbCI+QWRkcmVzczwvc3Bhbj48c3BhbiBjbGFzcz0icC1tZXRhLXZhbCIgaWQ9InAtYWRkciI+4oCUPC9zcGFuPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InAtbWV0YS1pdGVtIiBpZD0icC1kdWUtd3JhcCIgc3R5bGU9ImRpc3BsYXk6bm9uZTsiPjxzcGFuIGNsYXNzPSJwLW1ldGEtbGFiZWwiPkR1ZTwvc3Bhbj48c3BhbiBjbGFzcz0icC1tZXRhLXZhbCIgaWQ9InAtZHVlIj7igJQ8L3NwYW4+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0icC1tZXRhLWl0ZW0iPjxzcGFuIGNsYXNzPSJwLW1ldGEtbGFiZWwiPlJlZjwvc3Bhbj48c3BhbiBjbGFzcz0icC1tZXRhLXZhbCIgaWQ9InAtcmVmLWlubGluZSI+4oCUPC9zcGFuPjwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0icC1kZXNjIiBpZD0icC1kZXNjIj5Xb3JrIGRlc2NyaXB0aW9uIHdpbGwgYXBwZWFyIGhlcmXigKY8L2Rpdj4KICAgICAgPHRhYmxlIGNsYXNzPSJwLWxpbmVzIiBpZD0icC1saW5lcyI+PHRyPjx0ZCBjb2xzcGFuPSIyIiBzdHlsZT0iY29sb3I6dmFyKC0tbXV0ZWQpO2ZvbnQtc2l6ZToxMXB4O3BhZGRpbmc6NnB4IDA7Ij5ObyBsaW5lIGl0ZW1zIHlldDwvdGQ+PC90cj48L3RhYmxlPgogICAgICA8ZGl2IGNsYXNzPSJwLXRvdGFsLXJvdyI+PHNwYW4gY2xhc3M9InAtdG90YWwtbGFiZWwiPlRvdGFsIChDQUQpPC9zcGFuPjxzcGFuIGNsYXNzPSJwLXRvdGFsLWFtdCIgaWQ9InAtdG90YWwiPiQwLjAwPC9zcGFuPjwvZGl2PgogICAgICA8YSBjbGFzcz0icC1wYXktYnRuIiBpZD0icC1wYXlidG4iIGhyZWY9IiMiPlBheSBOb3cg4oCUICQwLjAwPC9hPgogICAgICA8cCBjbGFzcz0icC1kdWUtbGluZSIgaWQ9InAtZHVlLWxpbmUiPjwvcD4KICAgICAgPGRpdiBjbGFzcz0icC1ub3RlcyIgaWQ9InAtbm90ZXMtYm94Ij48L2Rpdj4KICAgIDwvZGl2PgogIDwvZGl2PgoKICA8ZGl2IGNsYXNzPSJzdGF0dXMtbXNnIiBpZD0ic3RhdHVzTXNnIj48L2Rpdj4KICA8ZGl2IGNsYXNzPSJhY3Rpb24tcm93Ij4KICAgIDxidXR0b24gY2xhc3M9ImJ0bi1wcmltYXJ5IiBpZD0ic2VuZEJ0biIgb25jbGljaz0ic2VuZEludm9pY2UoKSI+CiAgICAgIDxzdmcgd2lkdGg9IjE1IiBoZWlnaHQ9IjE1IiB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PGxpbmUgeDE9IjIyIiB5MT0iMiIgeDI9IjExIiB5Mj0iMTMiLz48cG9seWdvbiBwb2ludHM9IjIyIDIgMTUgMjIgMTEgMTMgMiA5IDIyIDIiLz48L3N2Zz4KICAgICAgPHNwYW4gaWQ9InNlbmRUZXh0Ij5TZW5kIFF1b3RlIHRvIEN1c3RvbWVyPC9zcGFuPgogICAgICA8ZGl2IGNsYXNzPSJzcGlubmVyIiBpZD0ic2VuZFNwaW5uZXIiPjwvZGl2PgogICAgPC9idXR0b24+CiAgICA8YnV0dG9uIGNsYXNzPSJidG4tc2Vjb25kYXJ5IiBvbmNsaWNrPSJkb3dubG9hZFBERigpIj4KICAgICAgPHN2ZyB3aWR0aD0iMTQiIGhlaWdodD0iMTQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMjEgMTV2NGEyIDIgMCAwIDEtMiAySDVhMiAyIDAgMCAxLTItMnYtNCIvPjxwb2x5bGluZSBwb2ludHM9IjcgMTAgMTIgMTUgMTcgMTAiLz48bGluZSB4MT0iMTIiIHkxPSIxNSIgeDI9IjEyIiB5Mj0iMyIvPjwvc3ZnPgogICAgICBEb3dubG9hZCBQREYKICAgIDwvYnV0dG9uPgogIDwvZGl2Pgo8L2Rpdj4KPC9kaXY+Cgo8c2NyaXB0Pgpjb25zdCBCQUNLRU5EX1VSTCA9ICcnOwoKCmZ1bmN0aW9uIGZtdChuKSB7IHJldHVybiAnJCcgKyBOdW1iZXIobnx8MCkudG9GaXhlZCgyKS5yZXBsYWNlKC9cQig/PShcZHszfSkrKD8hXGQpKS9nLCcsJyk7IH0KZnVuY3Rpb24gZ2V0TGluZUl0ZW1zKCkgewogIHJldHVybiBBcnJheS5mcm9tKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5saW5lLWl0ZW0nKSkubWFwKHIgPT4gewogICAgY29uc3QgaSA9IHIucXVlcnlTZWxlY3RvckFsbCgnaW5wdXQnKTsKICAgIHJldHVybiB7IGxhYmVsOiBpWzBdLnZhbHVlLnRyaW0oKSwgYW1vdW50OiBwYXJzZUZsb2F0KGlbMV0udmFsdWUpfHwwIH07CiAgfSkuZmlsdGVyKGkgPT4gaS5sYWJlbCB8fCBpLmFtb3VudCA+IDApOwp9CmZ1bmN0aW9uIGdldFRvdGFsKCkgeyByZXR1cm4gZ2V0TGluZUl0ZW1zKCkucmVkdWNlKChzLGkpID0+IHMraS5hbW91bnQsIDApOyB9CgpsZXQgbGluZUl0ZW1Db3VudCA9IDA7CmZ1bmN0aW9uIGFkZExpbmVJdGVtKGxhYmVsPScnLCBhbW91bnQ9JycpIHsKICBsaW5lSXRlbUNvdW50Kys7CiAgY29uc3QgaWQgPSAnbGktJytsaW5lSXRlbUNvdW50OwogIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpOwogIHJvdy5jbGFzc05hbWUgPSAnbGluZS1pdGVtJzsgcm93LmlkID0gaWQ7CiAgcm93LmlubmVySFRNTCA9IGA8aW5wdXQgdHlwZT0idGV4dCIgcGxhY2Vob2xkZXI9ImUuZy4gTGFib3VyIOKAlCB0YXAgcmVwbGFjZW1lbnQiIHZhbHVlPSIke2xhYmVsfSIgb25pbnB1dD0idXBkYXRlUHJldmlldygpIiAvPjxpbnB1dCB0eXBlPSJudW1iZXIiIGNsYXNzPSJhbXQiIHBsYWNlaG9sZGVyPSIwLjAwIiB2YWx1ZT0iJHthbW91bnR9IiBtaW49IjAiIHN0ZXA9IjAuMDEiIG9uaW5wdXQ9InVwZGF0ZVByZXZpZXcoKSIgLz48YnV0dG9uIGNsYXNzPSJsaW5lLWl0ZW0tcmVtb3ZlIiBvbmNsaWNrPSJyZW1vdmVMaW5lSXRlbSgnJHtpZH0nKSIgdGl0bGU9IlJlbW92ZSI+4pyVPC9idXR0b24+YDsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbGluZUl0ZW1zJykuYXBwZW5kQ2hpbGQocm93KTsKICB1cGRhdGVQcmV2aWV3KCk7Cn0KZnVuY3Rpb24gcmVtb3ZlTGluZUl0ZW0oaWQpIHsgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoaWQpPy5yZW1vdmUoKTsgdXBkYXRlUHJldmlldygpOyB9CgpmdW5jdGlvbiB1cGRhdGVQcmV2aWV3KCkgewogIGNvbnN0IG5hbWUgICAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY3VzdG9tZXJOYW1lJykudmFsdWUgfHwgJ+KAlCc7CiAgY29uc3QgZW1haWwgICA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjdXN0b21lckVtYWlsJykudmFsdWUgfHwgJ+KAlCc7CiAgY29uc3QgcGhvbmUgICA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjdXN0b21lclBob25lJykudmFsdWUgfHwgJ+KAlCc7CiAgY29uc3QgYWRkciAgICA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdhZGRyZXNzJykudmFsdWUgfHwgJ+KAlCc7CiAgY29uc3QgZGVzYyAgICA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdqb2JEZXNjcmlwdGlvbicpLnZhbHVlIHx8ICdXb3JrIGRlc2NyaXB0aW9uIHdpbGwgYXBwZWFyIGhlcmXigKYnOwogIGNvbnN0IGR1ZSAgICAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZHVlRGF0ZScpLnZhbHVlLnRyaW0oKTsKICBjb25zdCByZWYgICAgID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3JlZmVyZW5jZScpLnZhbHVlLnRyaW0oKSB8fCAnQXV0by1nZW5lcmF0ZWQnOwogIGNvbnN0IG5vdGVzICAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbm90ZXMnKS52YWx1ZS50cmltKCk7CiAgY29uc3QgcGF5TGluayA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzdHJpcGVQYXltZW50TGluaycpLnZhbHVlLnRyaW0oKSB8fCAnIyc7CiAgY29uc3QgaXRlbXMgICA9IGdldExpbmVJdGVtcygpOwogIGNvbnN0IHRvdGFsICAgPSBnZXRUb3RhbCgpOwogIGNvbnN0IHRmICAgICAgPSBmbXQodG90YWwpOwoKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncC1uYW1lJykudGV4dENvbnRlbnQgICAgPSBuYW1lOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwLWVtYWlsJykudGV4dENvbnRlbnQgICA9IGVtYWlsOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwLXBob25lJykudGV4dENvbnRlbnQgICA9IHBob25lOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwLWFkZHInKS50ZXh0Q29udGVudCAgICA9IGFkZHI7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3AtcmVmJykudGV4dENvbnRlbnQgICAgID0gJ1JFRjogJyArIHJlZjsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncC1yZWYtaW5saW5lJykudGV4dENvbnRlbnQgPSByZWY7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3AtZGVzYycpLnRleHRDb250ZW50ICAgID0gZGVzYzsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncC10b3RhbCcpLnRleHRDb250ZW50ICAgPSB0ZjsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndG90YWxEaXNwbGF5JykudGV4dENvbnRlbnQgPSB0ZjsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncC1wYXlidG4nKS50ZXh0Q29udGVudCAgPSAnUGF5IE5vdyDigJQgJyArIHRmOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwLXBheWJ0bicpLmhyZWYgICAgICAgICA9IHBheUxpbms7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3N0cmlwZUFtb3VudEhpbnQnKS50ZXh0Q29udGVudCA9IHRmOwoKICBjb25zdCBkdWVXcmFwID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3AtZHVlLXdyYXAnKTsKICBjb25zdCBkdWVMaW5lID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3AtZHVlLWxpbmUnKTsKICBpZiAoZHVlKSB7CiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncC1kdWUnKS50ZXh0Q29udGVudCA9IGR1ZTsKICAgIGR1ZVdyYXAuc3R5bGUuZGlzcGxheSA9ICcnOwogICAgZHVlTGluZS50ZXh0Q29udGVudCA9ICdEdWUgYnkgJyArIGR1ZTsKICAgIGR1ZUxpbmUuc3R5bGUuZGlzcGxheSA9ICdibG9jayc7CiAgfSBlbHNlIHsKICAgIGR1ZVdyYXAuc3R5bGUuZGlzcGxheSA9ICdub25lJzsKICAgIGR1ZUxpbmUuc3R5bGUuZGlzcGxheSA9ICdub25lJzsKICB9CgogIGNvbnN0IG5vdGVzQm94ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Atbm90ZXMtYm94Jyk7CiAgaWYgKG5vdGVzKSB7IG5vdGVzQm94LnRleHRDb250ZW50ID0gbm90ZXM7IG5vdGVzQm94LnN0eWxlLmRpc3BsYXkgPSAnYmxvY2snOyB9CiAgZWxzZSB7IG5vdGVzQm94LnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7IH0KCiAgY29uc3QgbGluZXNFbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwLWxpbmVzJyk7CiAgbGluZXNFbC5pbm5lckhUTUwgPSBpdGVtcy5sZW5ndGggPT09IDAKICAgID8gJzx0cj48dGQgY29sc3Bhbj0iMiIgc3R5bGU9ImNvbG9yOnZhcigtLW11dGVkKTtmb250LXNpemU6MTFweDtwYWRkaW5nOjZweCAwOyI+Tm8gbGluZSBpdGVtcyB5ZXQ8L3RkPjwvdHI+JwogICAgOiBpdGVtcy5tYXAoaSA9PiBgPHRyPjx0ZCBzdHlsZT0icGFkZGluZzo2cHggMDtib3JkZXItYm90dG9tOjFweCBzb2xpZCB2YXIoLS1saW5lKTsiPiR7aS5sYWJlbH08L3RkPjx0ZCBzdHlsZT0icGFkZGluZzo2cHggMDtib3JkZXItYm90dG9tOjFweCBzb2xpZCB2YXIoLS1saW5lKTsiPiR7Zm10KGkuYW1vdW50KX08L3RkPjwvdHI+YCkuam9pbignJyk7Cn0KCmZ1bmN0aW9uIGRvd25sb2FkUERGKCkgewogIGlmICghd2luZG93LmpzcGRmIHx8ICF3aW5kb3cuanNwZGYuanNQREYpIHsKICAgIGFsZXJ0KCdQREYgbGlicmFyeSBmYWlsZWQgdG8gbG9hZCDigJQgcGxlYXNlIHJlZnJlc2ggdGhlIHBhZ2UgYW5kIHRyeSBhZ2Fpbi4nKTsKICAgIHJldHVybjsKICB9CiAgY29uc3QgeyBqc1BERiB9ID0gd2luZG93LmpzcGRmOwogIGNvbnN0IGRvYyA9IG5ldyBqc1BERih7IHVuaXQ6J21tJywgZm9ybWF0OidhNCcgfSk7CiAgY29uc3QgVyA9IDIxMCwgbWFyZ2luID0gMTgsIGNXID0gVyAtIG1hcmdpbioyOwoKICBjb25zdCBuYW1lICAgID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2N1c3RvbWVyTmFtZScpLnZhbHVlICAgfHwgJ+KAlCc7CiAgY29uc3QgZW1haWwgICA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjdXN0b21lckVtYWlsJykudmFsdWUgIHx8ICfigJQnOwogIGNvbnN0IHBob25lICAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY3VzdG9tZXJQaG9uZScpLnZhbHVlICB8fCAnJzsKICBjb25zdCBhZGRyICAgID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2FkZHJlc3MnKS52YWx1ZSAgICAgICAgfHwgJyc7CiAgY29uc3QgZGVzYyAgICA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdqb2JEZXNjcmlwdGlvbicpLnZhbHVlIHx8ICcnOwogIGNvbnN0IGR1ZSAgICAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZHVlRGF0ZScpLnZhbHVlICAgICAgICB8fCAnJzsKICBjb25zdCByZWYgICAgID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3JlZmVyZW5jZScpLnZhbHVlLnRyaW0oKSB8fCAoJ0lOVi0nK01hdGguZmxvb3IoMTAwMDArTWF0aC5yYW5kb20oKSo5MDAwMCkpOwogIGNvbnN0IG5vdGVzICAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbm90ZXMnKS52YWx1ZS50cmltKCkgICB8fCAnJzsKICBjb25zdCBwYXlMaW5rID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3N0cmlwZVBheW1lbnRMaW5rJykudmFsdWUudHJpbSgpIHx8ICcnOwogIGNvbnN0IGl0ZW1zICAgPSBnZXRMaW5lSXRlbXMoKTsKICBjb25zdCB0b3RhbCAgID0gZ2V0VG90YWwoKTsKICBjb25zdCBpc3N1ZWQgID0gbmV3IERhdGUoKS50b0xvY2FsZURhdGVTdHJpbmcoJ2VuLUNBJyx7eWVhcjonbnVtZXJpYycsbW9udGg6J2xvbmcnLGRheTonbnVtZXJpYyd9KTsKCiAgbGV0IHkgPSAwOwoKICAvLyBEYXJrIGhlYWRlcgogIGRvYy5zZXRGaWxsQ29sb3IoMjgsMjgsMjgpOyBkb2MucmVjdCgwLDAsVywyOCwnRicpOwogIGRvYy5zZXRUZXh0Q29sb3IoMjU1LDI1NSwyNTUpOyBkb2Muc2V0Rm9udCgnaGVsdmV0aWNhJywnYm9sZCcpOyBkb2Muc2V0Rm9udFNpemUoMTYpOwogIGRvYy50ZXh0KCdIb21lIDEwMScsIG1hcmdpbiwgMTMpOwogIGRvYy5zZXRGb250KCdoZWx2ZXRpY2EnLCdub3JtYWwnKTsgZG9jLnNldEZvbnRTaXplKDgpOyBkb2Muc2V0VGV4dENvbG9yKDE3MCwxNzAsMTcwKTsKICBkb2MudGV4dCgnUXVvdGUgJiBQYXltZW50IOKAlCBJc3N1ZWQgJytpc3N1ZWQsIG1hcmdpbiwgMjEpOwogIHkgPSAyODsKCiAgLy8gR29sZCBiYXIKICBkb2Muc2V0RmlsbENvbG9yKDIwMCwxNDYsNDIpOyBkb2MucmVjdCgwLHksVywxMiwnRicpOwogIGRvYy5zZXRUZXh0Q29sb3IoMjU1LDI1NSwyNTUpOyBkb2Muc2V0Rm9udCgnaGVsdmV0aWNhJywnYm9sZCcpOyBkb2Muc2V0Rm9udFNpemUoMTApOwogIGRvYy50ZXh0KCdSRUY6ICcrcmVmLCBtYXJnaW4sIHkrOCk7CiAgZG9jLnNldEZvbnRTaXplKDkpOyBkb2MudGV4dCgnUXVvdGUnLCBXLW1hcmdpbiwgeSs4LCB7YWxpZ246J3JpZ2h0J30pOwogIHkgKz0gMTI7CgogIC8vIEN1c3RvbWVyIGJsb2NrCiAgeSArPSAxMDsKICBjb25zdCBjdXN0TGluZXMgPSBbZW1haWwsIHBob25lLCBhZGRyXS5maWx0ZXIoQm9vbGVhbik7CiAgY29uc3QgY3VzdEggPSAyMiArIGN1c3RMaW5lcy5sZW5ndGggKiA2OwogIGRvYy5zZXRGaWxsQ29sb3IoMjQ3LDI0NCwyMzkpOyBkb2Mucm91bmRlZFJlY3QobWFyZ2luLHksY1csY3VzdEgsMywzLCdGJyk7CiAgZG9jLnNldFRleHRDb2xvcigxNzAsMTcwLDE3MCk7IGRvYy5zZXRGb250U2l6ZSg3LjUpOyBkb2Muc2V0Rm9udCgnaGVsdmV0aWNhJywnYm9sZCcpOwogIGRvYy50ZXh0KCdQUkVQQVJFRCBGT1InLCBtYXJnaW4rNSwgeSs4KTsKICBkb2Muc2V0VGV4dENvbG9yKDI4LDI4LDI4KTsgZG9jLnNldEZvbnRTaXplKDEzKTsKICBkb2MudGV4dChuYW1lLCBtYXJnaW4rNSwgeSsxNik7CiAgbGV0IGN5ID0geSsyMjsKICBkb2Muc2V0Rm9udCgnaGVsdmV0aWNhJywnbm9ybWFsJyk7IGRvYy5zZXRGb250U2l6ZSg5KTsgZG9jLnNldFRleHRDb2xvcig4MCw4MCw4MCk7CiAgY3VzdExpbmVzLmZvckVhY2gobCA9PiB7IGRvYy50ZXh0KGwsIG1hcmdpbis1LCBjeSk7IGN5Kz02OyB9KTsKICB5ID0gY3kgKyA0OwoKICAvLyBEZXNjcmlwdGlvbgogIGlmIChkZXNjKSB7CiAgICB5ICs9IDI7CiAgICBkb2Muc2V0VGV4dENvbG9yKDE3MCwxNzAsMTcwKTsgZG9jLnNldEZvbnRTaXplKDcuNSk7IGRvYy5zZXRGb250KCdoZWx2ZXRpY2EnLCdib2xkJyk7CiAgICBkb2MudGV4dCgnV09SSyBERVNDUklQVElPTicsIG1hcmdpbiwgeSsyKTsgeSArPSA2OwogICAgY29uc3QgZExpbmVzID0gZG9jLnNwbGl0VGV4dFRvU2l6ZShkZXNjLCBjVy04KTsKICAgIGNvbnN0IGRIID0gZExpbmVzLmxlbmd0aCo1KzEwOwogICAgZG9jLnNldEZpbGxDb2xvcigyNDcsMjQ0LDIzOSk7IGRvYy5yb3VuZGVkUmVjdChtYXJnaW4seSxjVyxkSCwyLDIsJ0YnKTsKICAgIGRvYy5zZXRGaWxsQ29sb3IoMjAwLDE0Niw0Mik7IGRvYy5yZWN0KG1hcmdpbix5LDIsZEgsJ0YnKTsKICAgIGRvYy5zZXRUZXh0Q29sb3IoNjAsNjAsNjApOyBkb2Muc2V0Rm9udFNpemUoOS41KTsgZG9jLnNldEZvbnQoJ2hlbHZldGljYScsJ25vcm1hbCcpOwogICAgZG9jLnRleHQoZExpbmVzLCBtYXJnaW4rNiwgeSs3KTsKICAgIHkgKz0gZEgrODsKICB9CgogIC8vIExpbmUgaXRlbXMKICBkb2Muc2V0VGV4dENvbG9yKDE3MCwxNzAsMTcwKTsgZG9jLnNldEZvbnRTaXplKDcuNSk7IGRvYy5zZXRGb250KCdoZWx2ZXRpY2EnLCdib2xkJyk7CiAgZG9jLnRleHQoJ1FVT1RFIEJSRUFLRE9XTicsIG1hcmdpbiwgeSsyKTsgeSArPSA2OwogIGRvYy5zZXREcmF3Q29sb3IoMjIwLDIxNSwyMDUpOyBkb2Muc2V0TGluZVdpZHRoKDAuMik7CiAgaXRlbXMuZm9yRWFjaChpdGVtID0+IHsKICAgIGRvYy5zZXRGb250KCdoZWx2ZXRpY2EnLCdub3JtYWwnKTsgZG9jLnNldEZvbnRTaXplKDEwKTsgZG9jLnNldFRleHRDb2xvcig2MCw2MCw2MCk7CiAgICBkb2MudGV4dChpdGVtLmxhYmVsLCBtYXJnaW4sIHkrNik7CiAgICBkb2MudGV4dChmbXQoaXRlbS5hbW91bnQpLCBXLW1hcmdpbiwgeSs2LCB7YWxpZ246J3JpZ2h0J30pOwogICAgZG9jLmxpbmUobWFyZ2luLCB5KzksIFctbWFyZ2luLCB5KzkpOyB5ICs9IDEwOwogIH0pOwoKICAvLyBUb3RhbAogIHkgKz0gMjsKICBkb2Muc2V0TGluZVdpZHRoKDAuOCk7IGRvYy5zZXREcmF3Q29sb3IoMjgsMjgsMjgpOwogIGRvYy5saW5lKG1hcmdpbiwgeSwgVy1tYXJnaW4sIHkpOyB5ICs9IDY7CiAgZG9jLnNldEZvbnQoJ2hlbHZldGljYScsJ2JvbGQnKTsgZG9jLnNldEZvbnRTaXplKDExKTsgZG9jLnNldFRleHRDb2xvcigyOCwyOCwyOCk7CiAgZG9jLnRleHQoJ1RvdGFsIChDQUQpJywgbWFyZ2luLCB5KTsKICBkb2Muc2V0Rm9udFNpemUoMTUpOyBkb2Muc2V0VGV4dENvbG9yKDIwMCwxNDYsNDIpOwogIGRvYy50ZXh0KGZtdCh0b3RhbCksIFctbWFyZ2luLCB5LCB7YWxpZ246J3JpZ2h0J30pOyB5ICs9IDg7CgogIGlmIChkdWUpIHsKICAgIGRvYy5zZXRGb250KCdoZWx2ZXRpY2EnLCdpdGFsaWMnKTsgZG9jLnNldEZvbnRTaXplKDkpOyBkb2Muc2V0VGV4dENvbG9yKDEzMCwxMzAsMTMwKTsKICAgIGRvYy50ZXh0KCdEdWUgYnkgJytkdWUsIG1hcmdpbiwgeSk7IHkgKz0gODsKICB9CgogIGlmIChub3RlcykgewogICAgeSArPSA0OwogICAgZG9jLnNldFRleHRDb2xvcigxNzAsMTcwLDE3MCk7IGRvYy5zZXRGb250U2l6ZSg3LjUpOyBkb2Muc2V0Rm9udCgnaGVsdmV0aWNhJywnYm9sZCcpOwogICAgZG9jLnRleHQoJ05PVEVTJywgbWFyZ2luLCB5KTsgeSArPSA1OwogICAgY29uc3QgbkxpbmVzID0gZG9jLnNwbGl0VGV4dFRvU2l6ZShub3RlcywgY1ctNik7CiAgICBjb25zdCBuSCA9IG5MaW5lcy5sZW5ndGgqNSs4OwogICAgZG9jLnNldEZpbGxDb2xvcigyNDcsMjQ0LDIzOSk7IGRvYy5yb3VuZGVkUmVjdChtYXJnaW4seSxjVyxuSCwyLDIsJ0YnKTsKICAgIGRvYy5zZXRGb250KCdoZWx2ZXRpY2EnLCdub3JtYWwnKTsgZG9jLnNldEZvbnRTaXplKDkpOyBkb2Muc2V0VGV4dENvbG9yKDEwMCwxMDAsMTAwKTsKICAgIGRvYy50ZXh0KG5MaW5lcywgbWFyZ2luKzQsIHkrNik7IHkgKz0gbkgrODsKICB9CgogIGlmIChwYXlMaW5rKSB7CiAgICB5ICs9IDQ7CiAgICBkb2Muc2V0RmlsbENvbG9yKDI4LDI4LDI4KTsgZG9jLnJvdW5kZWRSZWN0KG1hcmdpbix5LGNXLDE0LDMsMywnRicpOwogICAgZG9jLnNldFRleHRDb2xvcigyNTUsMjU1LDI1NSk7IGRvYy5zZXRGb250KCdoZWx2ZXRpY2EnLCdib2xkJyk7IGRvYy5zZXRGb250U2l6ZSgxMSk7CiAgICBkb2MudGV4dCgnUGF5IE5vdyDigJQgJytmbXQodG90YWwpLCBXLzIsIHkrOS41LCB7YWxpZ246J2NlbnRlcid9KTsKICAgIGRvYy5saW5rKG1hcmdpbiwgeSwgY1csIDE0LCB7dXJsOiBwYXlMaW5rfSk7CiAgICB5ICs9IDE4OwogICAgZG9jLnNldEZvbnQoJ2hlbHZldGljYScsJ25vcm1hbCcpOyBkb2Muc2V0Rm9udFNpemUoOCk7IGRvYy5zZXRUZXh0Q29sb3IoMTUwLDE1MCwxNTApOwogICAgZG9jLnRleHQoJ1NlY3VyZSBwYXltZW50IHBvd2VyZWQgYnkgU3RyaXBlJywgVy8yLCB5LCB7YWxpZ246J2NlbnRlcid9KTsKICB9CgogIC8vIEZvb3RlcgogIGRvYy5zZXRGaWxsQ29sb3IoMjQ3LDI0NCwyMzkpOyBkb2MucmVjdCgwLDI4MyxXLDE0LCdGJyk7CiAgZG9jLnNldEZvbnQoJ2hlbHZldGljYScsJ25vcm1hbCcpOyBkb2Muc2V0Rm9udFNpemUoOCk7IGRvYy5zZXRUZXh0Q29sb3IoMTUwLDE1MCwxNTApOwogIGRvYy50ZXh0KCdRdWVzdGlvbnM/IFJlcGx5IHRvIHRoaXMgcXVvdGUgb3IgY29udGFjdCBIb21lIDEwMSDigJQgQ2FsZ2FyeSwgQUInLCBtYXJnaW4sIDI5MSk7CgogIGNvbnN0IHNhZmVOYW1lID0gbmFtZS5yZXBsYWNlKC9bXmEtejAtOV0vZ2ksJ18nKS50b0xvd2VyQ2FzZSgpOwogIGRvYy5zYXZlKCdIb21lMTAxX1F1b3RlXycrcmVmKydfJytzYWZlTmFtZSsnLnBkZicpOwp9Cgphc3luYyBmdW5jdGlvbiBzZW5kSW52b2ljZSgpIHsKICBjb25zdCBuYW1lICAgID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2N1c3RvbWVyTmFtZScpLnZhbHVlLnRyaW0oKTsKICBjb25zdCBlbWFpbCAgID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2N1c3RvbWVyRW1haWwnKS52YWx1ZS50cmltKCk7CiAgY29uc3QgZGVzYyAgICA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdqb2JEZXNjcmlwdGlvbicpLnZhbHVlLnRyaW0oKTsKICBjb25zdCBwYXlMaW5rID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3N0cmlwZVBheW1lbnRMaW5rJykudmFsdWUudHJpbSgpOwogIGNvbnN0IHN0YXR1c0VsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3N0YXR1c01zZycpOwoKICBjb25zdCBzaG93ID0gKG1zZywgdHlwZSkgPT4gewogICAgc3RhdHVzRWwuaW5uZXJIVE1MID0gbXNnOwogICAgc3RhdHVzRWwuY2xhc3NOYW1lID0gJ3N0YXR1cy1tc2cgJyArIHR5cGU7CiAgICBzdGF0dXNFbC5zdHlsZS5kaXNwbGF5ID0gJ2Jsb2NrJzsKICAgIC8vIFNjcm9sbCB0byB0b3Agb2YgcGFnZSBzbyBlcnJvciBpcyBhbHdheXMgdmlzaWJsZQogICAgd2luZG93LnNjcm9sbFRvKHsgdG9wOiAwLCBiZWhhdmlvcjogJ3Ntb290aCcgfSk7CiAgICBzdGF0dXNFbC5zY3JvbGxJbnRvVmlldyh7IGJlaGF2aW9yOiAnc21vb3RoJywgYmxvY2s6ICduZWFyZXN0JyB9KTsKICB9OwoKICBpZiAoIW5hbWUpICAgIHJldHVybiBzaG93KCdQbGVhc2UgZW50ZXIgdGhlIGN1c3RvbWVyIG5hbWUuJywgJ2Vycm9yJyk7CiAgaWYgKCFlbWFpbCB8fCAhL15bXlxzQF0rQFteXHNAXStcLlteXHNAXSskLy50ZXN0KGVtYWlsKSkgcmV0dXJuIHNob3coJ1BsZWFzZSBlbnRlciBhIHZhbGlkIGN1c3RvbWVyIGVtYWlsLicsICdlcnJvcicpOwogIGlmICghZGVzYykgICAgcmV0dXJuIHNob3coJ1BsZWFzZSBlbnRlciBhIHdvcmsgZGVzY3JpcHRpb24uJywgJ2Vycm9yJyk7CiAgaWYgKCFwYXlMaW5rKSB7CiAgICBjb25zdCBvayA9IGNvbmZpcm0oJ05vIFN0cmlwZSBQYXltZW50IExpbmsgYWRkZWQg4oCUIHRoZSBjdXN0b21lciB3b25cJ3QgaGF2ZSBhIFBheSBOb3cgYnV0dG9uLiBTZW5kIGFueXdheT8nKTsKICAgIGlmICghb2spIHJldHVybjsKICB9CiAgaWYgKGdldExpbmVJdGVtcygpLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHNob3coJ1BsZWFzZSBhZGQgYXQgbGVhc3Qgb25lIGxpbmUgaXRlbS4nLCAnZXJyb3InKTsKCiAgY29uc3QgYnRuICA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzZW5kQnRuJyk7CiAgY29uc3QgdHh0ICA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzZW5kVGV4dCcpOwogIGNvbnN0IHNwaW4gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc2VuZFNwaW5uZXInKTsKICBidG4uZGlzYWJsZWQgPSB0cnVlOwogIHR4dC50ZXh0Q29udGVudCA9ICdTZW5kaW5n4oCmJzsKICBzcGluLnN0eWxlLmRpc3BsYXkgPSAnYmxvY2snOwogIHN0YXR1c0VsLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7CgogIHRyeSB7CiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChCQUNLRU5EX1VSTCArICcvYXBpL2ludm9pY2UnLCB7CiAgICAgIG1ldGhvZDogJ1BPU1QnLAogICAgICBjcmVkZW50aWFsczogJ2luY2x1ZGUnLAogICAgICBoZWFkZXJzOiB7ICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicgfSwKICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoewogICAgICAgIGN1c3RvbWVyTmFtZTogICAgICBuYW1lLAogICAgICAgIGN1c3RvbWVyRW1haWw6ICAgICBlbWFpbCwKICAgICAgICBjdXN0b21lclBob25lOiAgICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2N1c3RvbWVyUGhvbmUnKS52YWx1ZS50cmltKCksCiAgICAgICAgYWRkcmVzczogICAgICAgICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdhZGRyZXNzJykudmFsdWUudHJpbSgpLAogICAgICAgIGpvYkRlc2NyaXB0aW9uOiAgICBkZXNjLAogICAgICAgIGxpbmVJdGVtczogICAgICAgICBnZXRMaW5lSXRlbXMoKSwKICAgICAgICBzdHJpcGVQYXltZW50TGluazogcGF5TGluaywKICAgICAgICBkdWVEYXRlOiAgICAgICAgICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2R1ZURhdGUnKS52YWx1ZS50cmltKCksCiAgICAgICAgcmVmZXJlbmNlOiAgICAgICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdyZWZlcmVuY2UnKS52YWx1ZS50cmltKCksCiAgICAgICAgbm90ZXM6ICAgICAgICAgICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdub3RlcycpLnZhbHVlLnRyaW0oKSwKICAgICAgfSksCiAgICB9KTsKICAgIGlmIChyZXMuc3RhdHVzID09PSA0MDEpIHsgd2luZG93LmxvY2F0aW9uLmhyZWYgPSAnL2ludm9pY2UnOyByZXR1cm47IH0KICAgIGNvbnN0IGRhdGEgPSBhd2FpdCByZXMuanNvbigpOwogICAgaWYgKCFyZXMub2spIHRocm93IG5ldyBFcnJvcihkYXRhLmVycm9yIHx8ICdTb21ldGhpbmcgd2VudCB3cm9uZy4nKTsKICAgIHNob3coJ1F1b3RlIHNlbnQgdG8gPHN0cm9uZz4nICsgZW1haWwgKyAnPC9zdHJvbmc+IOKAlCBSZWZlcmVuY2U6IDxzdHJvbmc+JyArIGRhdGEucmVmZXJlbmNlICsgJzwvc3Ryb25nPicsICdzdWNjZXNzJyk7CiAgfSBjYXRjaCAoZXJyKSB7CiAgICBzaG93KGVyci5tZXNzYWdlIHx8ICdGYWlsZWQgdG8gc2VuZC4gQ2hlY2sgeW91ciBjb25uZWN0aW9uIGFuZCB0cnkgYWdhaW4uJywgJ2Vycm9yJyk7CiAgfSBmaW5hbGx5IHsKICAgIGJ0bi5kaXNhYmxlZCA9IGZhbHNlOwogICAgdHh0LnRleHRDb250ZW50ID0gJ1NlbmQgUXVvdGUgdG8gQ3VzdG9tZXInOwogICAgc3Bpbi5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnOwogIH0KfQoKCmZ1bmN0aW9uIGNsZWFyRm9ybSgpIHsKICBpZiAoIWNvbmZpcm0oJ0NsZWFyIGFsbCBmaWVsZHMgYW5kIHN0YXJ0IGEgbmV3IHF1b3RlPycpKSByZXR1cm47CiAgWydjdXN0b21lck5hbWUnLCdjdXN0b21lckVtYWlsJywnY3VzdG9tZXJQaG9uZScsJ2FkZHJlc3MnLAogICAnam9iRGVzY3JpcHRpb24nLCdkdWVEYXRlJywncmVmZXJlbmNlJywnbm90ZXMnLCdzdHJpcGVQYXltZW50TGluayddCiAgICAuZm9yRWFjaChpZCA9PiB7IGNvbnN0IGVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoaWQpOyBpZihlbCkgZWwudmFsdWUgPSAnJzsgfSk7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2xpbmVJdGVtcycpLmlubmVySFRNTCA9ICcnOwogIGxpbmVJdGVtQ291bnQgPSAwOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwcmVmaWxsQmFubmVyJykuc3R5bGUuZGlzcGxheSA9ICdub25lJzsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc3RhdHVzTXNnJykuc3R5bGUuZGlzcGxheSA9ICdub25lJzsKICB3aW5kb3cuaGlzdG9yeS5yZXBsYWNlU3RhdGUoe30sICcnLCAnL2ludm9pY2UvYXBwJyk7CiAgYWRkTGluZUl0ZW0oKTsKICB1cGRhdGVQcmV2aWV3KCk7Cn0KCmZ1bmN0aW9uIGluaXQoKSB7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3AtZGF0ZScpLnRleHRDb250ZW50ID0gbmV3IERhdGUoKS50b0xvY2FsZURhdGVTdHJpbmcoJ2VuLUNBJyx7eWVhcjonbnVtZXJpYycsbW9udGg6J2xvbmcnLGRheTonbnVtZXJpYyd9KTsKICBjb25zdCBwID0gbmV3IFVSTFNlYXJjaFBhcmFtcyh3aW5kb3cubG9jYXRpb24uc2VhcmNoKTsKICBjb25zdCBzZXQgPSAoaWQsdmFsKSA9PiB7IGlmKHZhbCkgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoaWQpLnZhbHVlPXZhbDsgfTsKICBzZXQoJ2N1c3RvbWVyTmFtZScsICAgcC5nZXQoJ25hbWUnKSk7CiAgc2V0KCdjdXN0b21lckVtYWlsJywgIHAuZ2V0KCdlbWFpbCcpKTsKICBzZXQoJ2N1c3RvbWVyUGhvbmUnLCAgcC5nZXQoJ3Bob25lJykpOwogIHNldCgnYWRkcmVzcycsICAgICAgICBwLmdldCgnYWRkcmVzcycpKTsKICBzZXQoJ3JlZmVyZW5jZScsICAgICAgcC5nZXQoJ3JlZicpKTsKICBzZXQoJ2pvYkRlc2NyaXB0aW9uJywgcC5nZXQoJ2pvYicpKTsKICBpZiAocC5nZXQoJ25hbWUnKSkgewogICAgY29uc3QgYiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwcmVmaWxsQmFubmVyJyk7CiAgICBiLmlubmVySFRNTCA9ICc8c3Ryb25nPlByZS1maWxsZWQ8L3N0cm9uZz4gZnJvbSBzZXJ2aWNlIHJlcXVlc3QgJysocC5nZXQoJ3JlZicpfHwnJykrJyDigJQgcmV2aWV3IGRldGFpbHMsIGFkZCBsaW5lIGl0ZW1zLCB0aGVuIHNlbmQuJzsKICAgIGIuc3R5bGUuZGlzcGxheSA9ICdibG9jayc7CiAgfQogIGFkZExpbmVJdGVtKCk7CiAgdXBkYXRlUHJldmlldygpOwp9CgogIGluaXQoKTsKPC9zY3JpcHQ+CjwvYm9keT4KPC9odG1sPg==';

function getInvoiceAppHtml() {
  return Buffer.from(INVOICE_HTML_B64, 'base64').toString('utf8');
}




// ── GET /api/hash-password — one-time tool to generate a password hash ────────
// 1. Visit: https://your-backend.vercel.app/api/hash-password?p=YourPassword
// 2. Copy the $h101$... string shown on screen
// 3. Paste it as your INVOICE_PASSWORD environment variable on Vercel
// 4. Redeploy — you will then log in with YourPassword (plain), not the hash
app.get('/api/hash-password', (req, res) => {
  try {
    const p = req.query.p;
    if (!p) {
      return res.status(400).send(
        '<div style="font-family:Helvetica,sans-serif;padding:30px;background:#f7f4ef">'
        + '<h2>Usage</h2><p>Visit <code>/api/hash-password?p=YourChosenPassword</code></p>'
        + '</div>'
      );
    }
    // scryptSync — synchronous, no callbacks, guaranteed to complete
    const salt    = crypto.randomBytes(32);
    const hash    = crypto.scryptSync(p, salt, 64);
    const stored  = '$h101$' + salt.toString('hex') + '$' + hash.toString('hex');
    res.setHeader('Content-Type', 'text/html');
    res.send(
      '<div style="font-family:Helvetica,sans-serif;padding:30px;background:#f7f4ef;max-width:700px">'
      + '<h2 style="margin-bottom:16px">Home 101 — Password Hash</h2>'
      + '<p style="margin-bottom:8px;color:#555">Set <strong>INVOICE_PASSWORD</strong> on Vercel to:</p>'
      + '<pre style="background:#fff;border:1px solid #ddd;border-radius:8px;padding:16px;'
      +   'word-break:break-all;font-size:13px;margin-bottom:16px">' + stored + '</pre>'
      + '<p style="color:#555;font-size:14px;line-height:1.7">'
      + '✓ After setting this, you log in with your <strong>plain password</strong> — not the hash.<br>'
      + '✓ The hash above never reveals your real password.<br>'
      + '✓ You can delete this route from server.js once done if you prefer.'
      + '</p></div>'
    );
  } catch (err) {
    res.status(500).send('Error generating hash: ' + err.message);
  }
});


app.get('/health', (_, res) => res.json({ status: 'ok' }));

// Listen locally in dev; export for Vercel serverless in production
if (require.main === module) {
  app.listen(PORT, () => console.log(`Home 101 API running on http://localhost:${PORT}`));
}
module.exports = app;
