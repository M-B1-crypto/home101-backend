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
const INVOICE_HTML_B64 = 'PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9ImVuIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9IlVURi04Ij4KPG1ldGEgbmFtZT0idmlld3BvcnQiIGNvbnRlbnQ9IndpZHRoPWRldmljZS13aWR0aCwgaW5pdGlhbC1zY2FsZT0xLjAiPgo8dGl0bGU+SG9tZSAxMDEg4oCUIFNlbmQgUXVvdGU8L3RpdGxlPgo8bGluayBocmVmPSJodHRwczovL2ZvbnRzLmdvb2dsZWFwaXMuY29tL2NzczI/ZmFtaWx5PUZyYXVuY2VzOml0YWwsd2dodEAwLDcwMDswLDkwMCZmYW1pbHk9SW5zdHJ1bWVudCtTYW5zOndnaHRANDAwOzUwMDs2MDAmZGlzcGxheT1zd2FwIiByZWw9InN0eWxlc2hlZXQiPgo8c2NyaXB0IHNyYz0iaHR0cHM6Ly9jZG5qcy5jbG91ZGZsYXJlLmNvbS9hamF4L2xpYnMvanNwZGYvMi41LjEvanNwZGYudW1kLm1pbi5qcyI+PC9zY3JpcHQ+CjxzdHlsZT4KKiwgKjo6YmVmb3JlLCAqOjphZnRlciB7IGJveC1zaXppbmc6IGJvcmRlci1ib3g7IG1hcmdpbjogMDsgcGFkZGluZzogMDsgfQo6cm9vdCB7CiAgLS1iZzogI2Y3ZjRlZjsgLS1pbms6ICMxYzFjMWM7IC0tc2xhdGU6ICMzYTNhM2E7CiAgLS1nb2xkOiAjYzg5MjJhOyAtLW11dGVkOiAjODg4OyAtLWxpbmU6IHJnYmEoMjgsMjgsMjgsMC4xKTsKICAtLXdoaXRlOiAjZmZmZmZmOyAtLXN0b25lOiAjZjBlY2U0OyAtLXN1Y2Nlc3M6ICMyYTdhNTI7IC0tZXJyb3I6ICNiODMyMzI7Cn0KYm9keSB7IGZvbnQtZmFtaWx5OiAnSW5zdHJ1bWVudCBTYW5zJywgc2Fucy1zZXJpZjsgYmFja2dyb3VuZDogdmFyKC0tYmcpOyBjb2xvcjogdmFyKC0taW5rKTsgbWluLWhlaWdodDogMTAwdmg7IHBhZGRpbmc6IDQwcHggMjBweDsgfQoucGFnZSB7IG1heC13aWR0aDogNzIwcHg7IG1hcmdpbjogMCBhdXRvOyB9CgovKiBQQVNTV09SRCAqLwojbG9ja1NjcmVlbiB7IHBvc2l0aW9uOiBmaXhlZDsgaW5zZXQ6IDA7IGJhY2tncm91bmQ6IHZhcigtLWJnKTsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsganVzdGlmeS1jb250ZW50OiBjZW50ZXI7IHotaW5kZXg6IDk5OTsgfQoubG9jay1jYXJkIHsgYmFja2dyb3VuZDogdmFyKC0td2hpdGUpOyBib3JkZXItcmFkaXVzOiAyMHB4OyBwYWRkaW5nOiA0MHB4OyBib3gtc2hhZG93OiAwIDhweCA0MHB4IHJnYmEoMjgsMjgsMjgsMC4xMik7IGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWxpbmUpOyB3aWR0aDogMTAwJTsgbWF4LXdpZHRoOiAzNjBweDsgdGV4dC1hbGlnbjogY2VudGVyOyB9Ci5sb2NrLWxvZ28geyBmb250LWZhbWlseTogJ0ZyYXVuY2VzJywgc2VyaWY7IGZvbnQtc2l6ZTogMS41cmVtOyBmb250LXdlaWdodDogOTAwOyBmb250LXN0eWxlOiBpdGFsaWM7IG1hcmdpbi1ib3R0b206IDZweDsgfQoubG9jay1sb2dvIHNwYW4geyBjb2xvcjogdmFyKC0tZ29sZCk7IH0KLmxvY2stc3ViIHsgZm9udC1zaXplOiAwLjgycmVtOyBjb2xvcjogdmFyKC0tbXV0ZWQpOyBtYXJnaW4tYm90dG9tOiAyNHB4OyB9Ci5sb2NrLWNhcmQgaW5wdXQgeyB3aWR0aDogMTAwJTsgYm9yZGVyOiAxLjVweCBzb2xpZCB2YXIoLS1saW5lKTsgYm9yZGVyLXJhZGl1czogMTBweDsgcGFkZGluZzogMTJweCAxNHB4OyBmb250LXNpemU6IDAuOTVyZW07IGZvbnQtZmFtaWx5OiAnSW5zdHJ1bWVudCBTYW5zJywgc2Fucy1zZXJpZjsgYmFja2dyb3VuZDogdmFyKC0tYmcpOyBvdXRsaW5lOiBub25lOyB0ZXh0LWFsaWduOiBjZW50ZXI7IGxldHRlci1zcGFjaW5nOiAwLjE1ZW07IG1hcmdpbi1ib3R0b206IDEycHg7IHRyYW5zaXRpb246IGJvcmRlci1jb2xvciAuMnMsIGJveC1zaGFkb3cgLjJzOyB9Ci5sb2NrLWNhcmQgaW5wdXQ6Zm9jdXMgeyBib3JkZXItY29sb3I6IHZhcigtLWdvbGQpOyBib3gtc2hhZG93OiAwIDAgMCAzcHggcmdiYSgyMDAsMTQ2LDQyLDAuMTIpOyBiYWNrZ3JvdW5kOiB2YXIoLS13aGl0ZSk7IH0KLmxvY2stYnRuIHsgd2lkdGg6IDEwMCU7IGJhY2tncm91bmQ6IHZhcigtLWluayk7IGNvbG9yOiB2YXIoLS13aGl0ZSk7IGJvcmRlcjogbm9uZTsgYm9yZGVyLXJhZGl1czogMTBweDsgcGFkZGluZzogMTNweDsgZm9udC1mYW1pbHk6ICdJbnN0cnVtZW50IFNhbnMnLCBzYW5zLXNlcmlmOyBmb250LXNpemU6IDAuOTVyZW07IGZvbnQtd2VpZ2h0OiA3MDA7IGN1cnNvcjogcG9pbnRlcjsgdHJhbnNpdGlvbjogYmFja2dyb3VuZCAuMnM7IH0KLmxvY2stYnRuOmhvdmVyIHsgYmFja2dyb3VuZDogdmFyKC0tZ29sZCk7IH0KLmxvY2stZXJyb3IgeyBmb250LXNpemU6IDAuOHJlbTsgY29sb3I6IHZhcigtLWVycm9yKTsgbWFyZ2luLXRvcDogOHB4OyBkaXNwbGF5OiBub25lOyB9CgojbWFpbkNvbnRlbnQgeyBkaXNwbGF5OiBibG9jazsgfQoKLyogSEVBREVSICovCi5wYWdlLWhlYWRlciB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGp1c3RpZnktY29udGVudDogc3BhY2UtYmV0d2VlbjsgbWFyZ2luLWJvdHRvbTogMjRweDsgZmxleC13cmFwOiB3cmFwOyBnYXA6IDEwcHg7IH0KLmxvZ28geyBmb250LWZhbWlseTogJ0ZyYXVuY2VzJywgc2VyaWY7IGZvbnQtc2l6ZTogMS40cmVtOyBmb250LXdlaWdodDogOTAwOyBmb250LXN0eWxlOiBpdGFsaWM7IGNvbG9yOiB2YXIoLS1pbmspOyB9Ci5sb2dvIHNwYW4geyBjb2xvcjogdmFyKC0tZ29sZCk7IH0KLmJhZGdlIHsgYmFja2dyb3VuZDogdmFyKC0tc3RvbmUpOyBib3JkZXItcmFkaXVzOiA1MHB4OyBwYWRkaW5nOiA1cHggMTRweDsgZm9udC1zaXplOiAwLjcycmVtOyBmb250LXdlaWdodDogNzAwOyBjb2xvcjogdmFyKC0tbXV0ZWQpOyB0ZXh0LXRyYW5zZm9ybTogdXBwZXJjYXNlOyBsZXR0ZXItc3BhY2luZzogMC4wOGVtOyB9Ci5wcmVmaWxsLWJhbm5lciB7IGJhY2tncm91bmQ6IHJnYmEoMjAwLDE0Niw0MiwwLjEpOyBib3JkZXI6IDFweCBzb2xpZCByZ2JhKDIwMCwxNDYsNDIsMC4zKTsgYm9yZGVyLXJhZGl1czogMTBweDsgcGFkZGluZzogMTJweCAxOHB4OyBtYXJnaW4tYm90dG9tOiAyMHB4OyBmb250LXNpemU6IDAuODNyZW07IGNvbG9yOiB2YXIoLS1zbGF0ZSk7IGRpc3BsYXk6IG5vbmU7IH0KLnByZWZpbGwtYmFubmVyIHN0cm9uZyB7IGNvbG9yOiB2YXIoLS1nb2xkKTsgfQoKLyogQ0FSRCAqLwouY2FyZCB7IGJhY2tncm91bmQ6IHZhcigtLXdoaXRlKTsgYm9yZGVyLXJhZGl1czogMjBweDsgcGFkZGluZzogMzJweDsgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tbGluZSk7IGJveC1zaGFkb3c6IDAgNHB4IDIwcHggcmdiYSgyOCwyOCwyOCwwLjA2KTsgbWFyZ2luLWJvdHRvbTogMTZweDsgfQouY2FyZC10aXRsZSB7IGZvbnQtZmFtaWx5OiAnRnJhdW5jZXMnLCBzZXJpZjsgZm9udC1zaXplOiAxLjFyZW07IGZvbnQtd2VpZ2h0OiA5MDA7IG1hcmdpbi1ib3R0b206IDE4cHg7IHBhZGRpbmctYm90dG9tOiAxNHB4OyBib3JkZXItYm90dG9tOiAxcHggc29saWQgdmFyKC0tbGluZSk7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogOHB4OyB9Ci5jYXJkLXRpdGxlIHN2ZyB7IGNvbG9yOiB2YXIoLS1nb2xkKTsgfQoKLyogRklFTERTICovCi5maWVsZCB7IG1hcmdpbi1ib3R0b206IDE0cHg7IH0KLmZpZWxkIGxhYmVsIHsgZGlzcGxheTogYmxvY2s7IGZvbnQtc2l6ZTogMC43MnJlbTsgZm9udC13ZWlnaHQ6IDcwMDsgdGV4dC10cmFuc2Zvcm06IHVwcGVyY2FzZTsgbGV0dGVyLXNwYWNpbmc6IDAuMDhlbTsgY29sb3I6IHZhcigtLXNsYXRlKTsgbWFyZ2luLWJvdHRvbTogNnB4OyB9Ci5maWVsZCBpbnB1dCwgLmZpZWxkIHRleHRhcmVhIHsgd2lkdGg6IDEwMCU7IGJvcmRlcjogMS41cHggc29saWQgdmFyKC0tbGluZSk7IGJvcmRlci1yYWRpdXM6IDEwcHg7IHBhZGRpbmc6IDExcHggMTRweDsgZm9udC1mYW1pbHk6ICdJbnN0cnVtZW50IFNhbnMnLCBzYW5zLXNlcmlmOyBmb250LXNpemU6IDAuOTJyZW07IGNvbG9yOiB2YXIoLS1pbmspOyBiYWNrZ3JvdW5kOiB2YXIoLS1iZyk7IG91dGxpbmU6IG5vbmU7IHRyYW5zaXRpb246IGJvcmRlci1jb2xvciAuMnMsIGJveC1zaGFkb3cgLjJzOyB9Ci5maWVsZCBpbnB1dDpmb2N1cywgLmZpZWxkIHRleHRhcmVhOmZvY3VzIHsgYm9yZGVyLWNvbG9yOiB2YXIoLS1nb2xkKTsgYm94LXNoYWRvdzogMCAwIDAgM3B4IHJnYmEoMjAwLDE0Niw0MiwwLjEyKTsgYmFja2dyb3VuZDogdmFyKC0td2hpdGUpOyB9Ci5maWVsZCB0ZXh0YXJlYSB7IHJlc2l6ZTogdmVydGljYWw7IG1pbi1oZWlnaHQ6IDgwcHg7IGxpbmUtaGVpZ2h0OiAxLjY7IH0KLmZpZWxkLXJvdyB7IGRpc3BsYXk6IGZsZXg7IGdhcDogMTJweDsgfQouZmllbGQtcm93IC5maWVsZCB7IGZsZXg6IDE7IH0KLmZpZWxkLWhpbnQgeyBmb250LXNpemU6IDAuNzNyZW07IGNvbG9yOiB2YXIoLS1tdXRlZCk7IG1hcmdpbi10b3A6IDVweDsgbGluZS1oZWlnaHQ6IDEuNTsgfQoKLyogTElORSBJVEVNUyAqLwoubGluZS1pdGVtIHsgZGlzcGxheTogZmxleDsgZ2FwOiA4cHg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IG1hcmdpbi1ib3R0b206IDhweDsgfQoubGluZS1pdGVtIGlucHV0OmZpcnN0LWNoaWxkIHsgZmxleDogMTsgfQoubGluZS1pdGVtIGlucHV0LmFtdCB7IHdpZHRoOiAxMTBweDsgZmxleC1zaHJpbms6IDA7IH0KLmxpbmUtaXRlbS1yZW1vdmUgeyB3aWR0aDogMjhweDsgaGVpZ2h0OiAyOHB4OyBib3JkZXItcmFkaXVzOiA1MCU7IGJhY2tncm91bmQ6IHZhcigtLXN0b25lKTsgYm9yZGVyOiBub25lOyBjdXJzb3I6IHBvaW50ZXI7IGZvbnQtc2l6ZTogMC43NXJlbTsgY29sb3I6IHZhcigtLW11dGVkKTsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsganVzdGlmeS1jb250ZW50OiBjZW50ZXI7IGZsZXgtc2hyaW5rOiAwOyB0cmFuc2l0aW9uOiBhbGwgLjJzOyB9Ci5saW5lLWl0ZW0tcmVtb3ZlOmhvdmVyIHsgYmFja2dyb3VuZDogcmdiYSgxODQsNTAsNTAsMC4xMik7IGNvbG9yOiB2YXIoLS1lcnJvcik7IH0KLmFkZC1saW5lLWJ0biB7IGJhY2tncm91bmQ6IHRyYW5zcGFyZW50OyBib3JkZXI6IDEuNXB4IGRhc2hlZCB2YXIoLS1saW5lKTsgYm9yZGVyLXJhZGl1czogOHB4OyBwYWRkaW5nOiA4cHggMTZweDsgZm9udC1mYW1pbHk6ICdJbnN0cnVtZW50IFNhbnMnLCBzYW5zLXNlcmlmOyBmb250LXNpemU6IDAuODJyZW07IGNvbG9yOiB2YXIoLS1tdXRlZCk7IGN1cnNvcjogcG9pbnRlcjsgd2lkdGg6IDEwMCU7IHRyYW5zaXRpb246IGFsbCAuMnM7IG1hcmdpbi10b3A6IDRweDsgfQouYWRkLWxpbmUtYnRuOmhvdmVyIHsgYm9yZGVyLWNvbG9yOiB2YXIoLS1nb2xkKTsgY29sb3I6IHZhcigtLWdvbGQpOyB9Ci50b3RhbC1yb3cgeyBkaXNwbGF5OiBmbGV4OyBqdXN0aWZ5LWNvbnRlbnQ6IHNwYWNlLWJldHdlZW47IGFsaWduLWl0ZW1zOiBjZW50ZXI7IHBhZGRpbmc6IDE0cHggMCA0cHg7IGJvcmRlci10b3A6IDJweCBzb2xpZCB2YXIoLS1pbmspOyBtYXJnaW4tdG9wOiAxMHB4OyB9Ci50b3RhbC1yb3cgc3BhbjpmaXJzdC1jaGlsZCB7IGZvbnQtd2VpZ2h0OiA3MDA7IH0KLnRvdGFsLWFtb3VudCB7IGZvbnQtZmFtaWx5OiAnRnJhdW5jZXMnLCBzZXJpZjsgZm9udC1zaXplOiAxLjZyZW07IGZvbnQtd2VpZ2h0OiA5MDA7IGNvbG9yOiB2YXIoLS1nb2xkKTsgfQoKLyogU1RSSVBFIEhFTFBFUiAqLwouc3RyaXBlLWhlbHBlciB7IGJhY2tncm91bmQ6IHJnYmEoOTksOTEsMjU1LDAuMDUpOyBib3JkZXI6IDFweCBzb2xpZCByZ2JhKDk5LDkxLDI1NSwwLjE1KTsgYm9yZGVyLXJhZGl1czogMTJweDsgcGFkZGluZzogMTZweCAxOHB4OyBtYXJnaW4tYm90dG9tOiAxNHB4OyB9Ci5zdHJpcGUtaGVscGVyLXRpdGxlIHsgZm9udC1zaXplOiAwLjc1cmVtOyBmb250LXdlaWdodDogNzAwOyB0ZXh0LXRyYW5zZm9ybTogdXBwZXJjYXNlOyBsZXR0ZXItc3BhY2luZzogMC4wOGVtOyBjb2xvcjogIzYzNTZmZjsgbWFyZ2luLWJvdHRvbTogMTBweDsgfQouc3RyaXBlLXN0ZXBzIHsgZm9udC1zaXplOiAwLjgycmVtOyBjb2xvcjogdmFyKC0tc2xhdGUpOyBsaW5lLWhlaWdodDogMS45OyBtYXJnaW4tYm90dG9tOiAxMnB4OyB9Ci5zdHJpcGUtc3RlcHMgc3Ryb25nIHsgY29sb3I6IHZhcigtLWluayk7IH0KLnN0cmlwZS1hbXQgeyBkaXNwbGF5OiBpbmxpbmUtYmxvY2s7IGJhY2tncm91bmQ6IHJnYmEoOTksOTEsMjU1LDAuMSk7IGJvcmRlci1yYWRpdXM6IDZweDsgcGFkZGluZzogMXB4IDlweDsgZm9udC13ZWlnaHQ6IDcwMDsgY29sb3I6ICM2MzU2ZmY7IGZvbnQtc2l6ZTogMC44MnJlbTsgfQouc3RyaXBlLW9wZW4tYnRuIHsgZGlzcGxheTogaW5saW5lLWZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogN3B4OyBiYWNrZ3JvdW5kOiAjNjM1NmZmOyBjb2xvcjogd2hpdGU7IGJvcmRlcjogbm9uZTsgYm9yZGVyLXJhZGl1czogOHB4OyBwYWRkaW5nOiA5cHggMThweDsgZm9udC1mYW1pbHk6ICdJbnN0cnVtZW50IFNhbnMnLCBzYW5zLXNlcmlmOyBmb250LXNpemU6IDAuODJyZW07IGZvbnQtd2VpZ2h0OiA3MDA7IGN1cnNvcjogcG9pbnRlcjsgdGV4dC1kZWNvcmF0aW9uOiBub25lOyB0cmFuc2l0aW9uOiBiYWNrZ3JvdW5kIC4yczsgfQouc3RyaXBlLW9wZW4tYnRuOmhvdmVyIHsgYmFja2dyb3VuZDogIzRmNDNlMDsgfQoKLyogQlVUVE9OUyAqLwouYWN0aW9uLXJvdyB7IGRpc3BsYXk6IGZsZXg7IGdhcDogMTBweDsgbWFyZ2luLXRvcDogMjBweDsgZmxleC13cmFwOiB3cmFwOyB9Ci5idG4tcHJpbWFyeSB7IGZsZXg6IDI7IG1pbi13aWR0aDogMjAwcHg7IGJhY2tncm91bmQ6IHZhcigtLWluayk7IGNvbG9yOiB2YXIoLS13aGl0ZSk7IGJvcmRlcjogbm9uZTsgYm9yZGVyLXJhZGl1czogMTBweDsgcGFkZGluZzogMTRweDsgZm9udC1mYW1pbHk6ICdJbnN0cnVtZW50IFNhbnMnLCBzYW5zLXNlcmlmOyBmb250LXNpemU6IDAuOTVyZW07IGZvbnQtd2VpZ2h0OiA3MDA7IGN1cnNvcjogcG9pbnRlcjsgdHJhbnNpdGlvbjogYmFja2dyb3VuZCAuMnM7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGp1c3RpZnktY29udGVudDogY2VudGVyOyBnYXA6IDhweDsgfQouYnRuLXByaW1hcnk6aG92ZXIgeyBiYWNrZ3JvdW5kOiB2YXIoLS1nb2xkKTsgfQouYnRuLXByaW1hcnk6ZGlzYWJsZWQgeyBvcGFjaXR5OiAwLjU7IGN1cnNvcjogbm90LWFsbG93ZWQ7IH0KLmJ0bi1zZWNvbmRhcnkgeyBmbGV4OiAxOyBtaW4td2lkdGg6IDE0MHB4OyBiYWNrZ3JvdW5kOiB0cmFuc3BhcmVudDsgY29sb3I6IHZhcigtLWluayk7IGJvcmRlcjogMS41cHggc29saWQgdmFyKC0tbGluZSk7IGJvcmRlci1yYWRpdXM6IDEwcHg7IHBhZGRpbmc6IDE0cHg7IGZvbnQtZmFtaWx5OiAnSW5zdHJ1bWVudCBTYW5zJywgc2Fucy1zZXJpZjsgZm9udC1zaXplOiAwLjlyZW07IGZvbnQtd2VpZ2h0OiA2MDA7IGN1cnNvcjogcG9pbnRlcjsgdHJhbnNpdGlvbjogYWxsIC4yczsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsganVzdGlmeS1jb250ZW50OiBjZW50ZXI7IGdhcDogN3B4OyB9Ci5idG4tc2Vjb25kYXJ5OmhvdmVyIHsgYm9yZGVyLWNvbG9yOiB2YXIoLS1pbmspOyBiYWNrZ3JvdW5kOiB2YXIoLS1zdG9uZSk7IH0KLnNwaW5uZXIgeyB3aWR0aDogMTZweDsgaGVpZ2h0OiAxNnB4OyBib3JkZXI6IDIuNXB4IHNvbGlkIHJnYmEoMjU1LDI1NSwyNTUsMC4zKTsgYm9yZGVyLXRvcC1jb2xvcjogd2hpdGU7IGJvcmRlci1yYWRpdXM6IDUwJTsgYW5pbWF0aW9uOiBzcGluIC43cyBsaW5lYXIgaW5maW5pdGU7IGRpc3BsYXk6IG5vbmU7IH0KQGtleWZyYW1lcyBzcGluIHsgdG8geyB0cmFuc2Zvcm06IHJvdGF0ZSgzNjBkZWcpOyB9IH0KLnN0YXR1cy1tc2cgeyBib3JkZXItcmFkaXVzOiAxMHB4OyBwYWRkaW5nOiAxM3B4IDE4cHg7IGZvbnQtc2l6ZTogMC44NXJlbTsgZm9udC13ZWlnaHQ6IDYwMDsgbWFyZ2luLXRvcDogMTJweDsgZGlzcGxheTogbm9uZTsgbGluZS1oZWlnaHQ6IDEuNTsgfQouc3RhdHVzLW1zZy5zdWNjZXNzIHsgYmFja2dyb3VuZDogcmdiYSg0MiwxMjIsODIsMC4wOCk7IGJvcmRlcjogMXB4IHNvbGlkIHJnYmEoNDIsMTIyLDgyLDAuMjUpOyBjb2xvcjogdmFyKC0tc3VjY2Vzcyk7IH0KLnN0YXR1cy1tc2cuZXJyb3IgeyBiYWNrZ3JvdW5kOiByZ2JhKDE4NCw1MCw1MCwwLjA3KTsgYm9yZGVyOiAxcHggc29saWQgcmdiYSgxODQsNTAsNTAsMC4yKTsgY29sb3I6IHZhcigtLWVycm9yKTsgfQoKLyogUFJFVklFVyAqLwoucHJldmlldy1sYWJlbCB7IGZvbnQtc2l6ZTogMC43MnJlbTsgZm9udC13ZWlnaHQ6IDcwMDsgdGV4dC10cmFuc2Zvcm06IHVwcGVyY2FzZTsgbGV0dGVyLXNwYWNpbmc6IDAuMDhlbTsgY29sb3I6IHZhcigtLW11dGVkKTsgbWFyZ2luLWJvdHRvbTogMTBweDsgbWFyZ2luLXRvcDogOHB4OyB9Ci5wcmV2aWV3LWNhcmQgeyBiYWNrZ3JvdW5kOiB2YXIoLS13aGl0ZSk7IGJvcmRlci1yYWRpdXM6IDE0cHg7IG92ZXJmbG93OiBoaWRkZW47IGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWxpbmUpOyBmb250LXNpemU6IDEzcHg7IGJveC1zaGFkb3c6IDAgNHB4IDIwcHggcmdiYSgyOCwyOCwyOCwwLjA2KTsgfQoucC1oZWFkZXIgeyBiYWNrZ3JvdW5kOiB2YXIoLS1pbmspOyBwYWRkaW5nOiAxNnB4IDIycHg7IH0KLnAtbG9nbyB7IGZvbnQtd2VpZ2h0OiA5MDA7IGNvbG9yOiB3aGl0ZTsgZm9udC1zdHlsZTogaXRhbGljOyBmb250LXNpemU6IDE2cHg7IH0KLnAtc3ViIHsgY29sb3I6IHJnYmEoMjU1LDI1NSwyNTUsMC40KTsgZm9udC1zaXplOiAxMXB4OyBtYXJnaW4tdG9wOiAzcHg7IH0KLnAtYmFyIHsgYmFja2dyb3VuZDogdmFyKC0tZ29sZCk7IHBhZGRpbmc6IDEwcHggMjJweDsgZGlzcGxheTogZmxleDsganVzdGlmeS1jb250ZW50OiBzcGFjZS1iZXR3ZWVuOyBhbGlnbi1pdGVtczogY2VudGVyOyB9Ci5wLWJhciBzcGFuIHsgY29sb3I6IHdoaXRlOyBmb250LXdlaWdodDogNzAwOyBmb250LXNpemU6IDEycHg7IH0KLnAtYm9keSB7IHBhZGRpbmc6IDIwcHggMjJweDsgfQoucC1tZXRhIHsgZGlzcGxheTogZmxleDsgZ2FwOiAxNnB4OyBmbGV4LXdyYXA6IHdyYXA7IG1hcmdpbi1ib3R0b206IDE0cHg7IH0KLnAtbWV0YS1pdGVtIHsgZm9udC1zaXplOiAxMXB4OyB9Ci5wLW1ldGEtbGFiZWwgeyBjb2xvcjogdmFyKC0tbXV0ZWQpOyBmb250LXdlaWdodDogNzAwOyB0ZXh0LXRyYW5zZm9ybTogdXBwZXJjYXNlOyBsZXR0ZXItc3BhY2luZzogMC4wNmVtOyBkaXNwbGF5OiBibG9jazsgbWFyZ2luLWJvdHRvbTogMnB4OyBmb250LXNpemU6IDEwcHg7IH0KLnAtbWV0YS12YWwgeyBjb2xvcjogdmFyKC0taW5rKTsgZm9udC13ZWlnaHQ6IDYwMDsgfQoucC1kZXNjIHsgYmFja2dyb3VuZDogdmFyKC0tc3RvbmUpOyBib3JkZXItbGVmdDogM3B4IHNvbGlkIHZhcigtLWdvbGQpOyBwYWRkaW5nOiAxMHB4IDE0cHg7IGJvcmRlci1yYWRpdXM6IDAgOHB4IDhweCAwOyBmb250LXNpemU6IDEycHg7IGNvbG9yOiB2YXIoLS1zbGF0ZSk7IG1hcmdpbi1ib3R0b206IDE0cHg7IGxpbmUtaGVpZ2h0OiAxLjY1OyB3aGl0ZS1zcGFjZTogcHJlLXdyYXA7IHdvcmQtYnJlYWs6IGJyZWFrLXdvcmQ7IH0KLnAtbGluZXMgeyB3aWR0aDogMTAwJTsgYm9yZGVyLWNvbGxhcHNlOiBjb2xsYXBzZTsgZm9udC1zaXplOiAxMnB4OyBtYXJnaW4tYm90dG9tOiAxMHB4OyB9Ci5wLWxpbmVzIHRkIHsgcGFkZGluZzogNnB4IDA7IGJvcmRlci1ib3R0b206IDFweCBzb2xpZCB2YXIoLS1saW5lKTsgY29sb3I6IHZhcigtLXNsYXRlKTsgfQoucC1saW5lcyB0ZDpsYXN0LWNoaWxkIHsgdGV4dC1hbGlnbjogcmlnaHQ7IGZvbnQtd2VpZ2h0OiA2MDA7IHdoaXRlLXNwYWNlOiBub3dyYXA7IH0KLnAtdG90YWwtcm93IHsgZGlzcGxheTogZmxleDsganVzdGlmeS1jb250ZW50OiBzcGFjZS1iZXR3ZWVuOyBhbGlnbi1pdGVtczogY2VudGVyOyBwYWRkaW5nOiAxMHB4IDAgMTRweDsgfQoucC10b3RhbC1sYWJlbCB7IGZvbnQtd2VpZ2h0OiA3MDA7IGZvbnQtc2l6ZTogMTNweDsgfQoucC10b3RhbC1hbXQgeyBmb250LWZhbWlseTogJ0ZyYXVuY2VzJywgc2VyaWY7IGZvbnQtc2l6ZTogMS4zcmVtOyBmb250LXdlaWdodDogOTAwOyBjb2xvcjogdmFyKC0tZ29sZCk7IH0KLnAtcGF5LWJ0biB7IGRpc3BsYXk6IGJsb2NrOyBiYWNrZ3JvdW5kOiB2YXIoLS1pbmspOyBjb2xvcjogd2hpdGU7IHRleHQtYWxpZ246IGNlbnRlcjsgcGFkZGluZzogMTFweDsgYm9yZGVyLXJhZGl1czogOHB4OyBmb250LXdlaWdodDogNzAwOyBmb250LXNpemU6IDEzcHg7IHRleHQtZGVjb3JhdGlvbjogbm9uZTsgbWFyZ2luLWJvdHRvbTogNHB4OyB9Ci5wLW5vdGVzIHsgYmFja2dyb3VuZDogdmFyKC0tc3RvbmUpOyBib3JkZXItcmFkaXVzOiA4cHg7IHBhZGRpbmc6IDEwcHggMTRweDsgZm9udC1zaXplOiAxMXB4OyBjb2xvcjogdmFyKC0tbXV0ZWQpOyBsaW5lLWhlaWdodDogMS42OyBtYXJnaW4tdG9wOiAxMHB4OyBkaXNwbGF5OiBub25lOyB3aGl0ZS1zcGFjZTogcHJlLXdyYXA7IH0KLnAtZHVlLWxpbmUgeyBmb250LXNpemU6IDExcHg7IGNvbG9yOiB2YXIoLS1tdXRlZCk7IHRleHQtYWxpZ246IGNlbnRlcjsgbWFyZ2luLXRvcDogNnB4OyBkaXNwbGF5OiBub25lOyB9CgpAbWVkaWEobWF4LXdpZHRoOjYwMHB4KSB7IC5maWVsZC1yb3cgeyBmbGV4LWRpcmVjdGlvbjogY29sdW1uOyBnYXA6IDA7IH0gLmNhcmQgeyBwYWRkaW5nOiAyMnB4OyB9IC5hY3Rpb24tcm93IHsgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsgfSAuYnRuLXByaW1hcnksIC5idG4tc2Vjb25kYXJ5IHsgZmxleDogbm9uZTsgd2lkdGg6IDEwMCU7IH0gfQo8L3N0eWxlPgo8L2hlYWQ+Cjxib2R5PgoKPGRpdiBpZD0ibWFpbkNvbnRlbnQiPgo8ZGl2IGNsYXNzPSJwYWdlIj4KCiAgPGRpdiBjbGFzcz0icGFnZS1oZWFkZXIiPgogICAgPGRpdiBjbGFzcz0ibG9nbyI+SG9tZTxzcGFuPiAxMDE8L3NwYW4+PC9kaXY+CiAgICA8c3BhbiBjbGFzcz0iYmFkZ2UiPkludGVybmFsIOKAlCBTZW5kIFF1b3RlPC9zcGFuPgogICAgPGJ1dHRvbiBvbmNsaWNrPSJmZXRjaCgnL2FwaS9sb2dvdXQnLHttZXRob2Q6J1BPU1QnLGNyZWRlbnRpYWxzOidpbmNsdWRlJ30pLnRoZW4oKCk9Pnt3aW5kb3cubG9jYXRpb24uaHJlZj0nL2ludm9pY2UnfSkiIHN0eWxlPSJiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O2JvcmRlcjoxLjVweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjhweDtwYWRkaW5nOjZweCAxNHB4O2ZvbnQtc2l6ZTowLjc4cmVtO2ZvbnQtd2VpZ2h0OjYwMDtjb2xvcjp2YXIoLS1tdXRlZCk7Y3Vyc29yOnBvaW50ZXI7Zm9udC1mYW1pbHk6J0luc3RydW1lbnQgU2Fucycsc2Fucy1zZXJpZjsiPkxvZyBvdXQ8L2J1dHRvbj4KICA8L2Rpdj4KICA8ZGl2IGNsYXNzPSJwcmVmaWxsLWJhbm5lciIgaWQ9InByZWZpbGxCYW5uZXIiPjwvZGl2PgoKICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgIDxkaXYgY2xhc3M9ImNhcmQtdGl0bGUiPgogICAgICA8c3ZnIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxwYXRoIGQ9Ik0yMCAyMXYtMmE0IDQgMCAwIDAtNC00SDhhNCA0IDAgMCAwLTQgNHYyIi8+PGNpcmNsZSBjeD0iMTIiIGN5PSI3IiByPSI0Ii8+PC9zdmc+CiAgICAgIEN1c3RvbWVyIERldGFpbHMKICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0iZmllbGQtcm93Ij4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5GdWxsIE5hbWU8L2xhYmVsPjxpbnB1dCB0eXBlPSJ0ZXh0IiBpZD0iY3VzdG9tZXJOYW1lIiBwbGFjZWhvbGRlcj0iSmFuZSBTbWl0aCIgb25pbnB1dD0idXBkYXRlUHJldmlldygpIiAvPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlBob25lPC9sYWJlbD48aW5wdXQgdHlwZT0idGVsIiBpZD0iY3VzdG9tZXJQaG9uZSIgcGxhY2Vob2xkZXI9Iig0MDMpIDU1NS0wMTkyIiBvbmlucHV0PSJ1cGRhdGVQcmV2aWV3KCkiIC8+PC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+RW1haWwgQWRkcmVzczwvbGFiZWw+PGlucHV0IHR5cGU9ImVtYWlsIiBpZD0iY3VzdG9tZXJFbWFpbCIgcGxhY2Vob2xkZXI9ImphbmVAZXhhbXBsZS5jb20iIG9uaW5wdXQ9InVwZGF0ZVByZXZpZXcoKSIgLz48L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+U2VydmljZSBBZGRyZXNzPC9sYWJlbD48aW5wdXQgdHlwZT0idGV4dCIgaWQ9ImFkZHJlc3MiIHBsYWNlaG9sZGVyPSI0MiBNYXBsZSBTdHJlZXQsIENhbGdhcnksIEFCIiBvbmlucHV0PSJ1cGRhdGVQcmV2aWV3KCkiIC8+PC9kaXY+CiAgPC9kaXY+CgogIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgPGRpdiBjbGFzcz0iY2FyZC10aXRsZSI+CiAgICAgIDxzdmcgd2lkdGg9IjE2IiBoZWlnaHQ9IjE2IiB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHBhdGggZD0iTTE0LjcgNi4zYTEgMSAwIDAgMCAwIDEuNGwxLjYgMS42YTEgMSAwIDAgMCAxLjQgMGwzLjc3LTMuNzdhNiA2IDAgMCAxLTcuOTQgNy45NGwtNi45MSA2LjkxYTIuMTIgMi4xMiAwIDAgMS0zLTNsNi45MS02LjkxYTYgNiAwIDAgMSA3Ljk0LTcuOTRsLTMuNzYgMy43NnoiLz48L3N2Zz4KICAgICAgSm9iIERldGFpbHMKICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5Xb3JrIERlc2NyaXB0aW9uPC9sYWJlbD48dGV4dGFyZWEgaWQ9ImpvYkRlc2NyaXB0aW9uIiBwbGFjZWhvbGRlcj0iZS5nLiBSZXBsYWNlIGtpdGNoZW4gdGFwIGFuZCByZXBhaXIgY29ycm9kZWQgcGlwZSB1bmRlciBzaW5rLiBMYWJvdXIgYW5kIG1hdGVyaWFscyBpbmNsdWRlZC4iIG9uaW5wdXQ9InVwZGF0ZVByZXZpZXcoKSI+PC90ZXh0YXJlYT48L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImZpZWxkIj4KICAgICAgPGxhYmVsPlF1b3RlIEJyZWFrZG93bjwvbGFiZWw+CiAgICAgIDxkaXYgaWQ9ImxpbmVJdGVtcyI+PC9kaXY+CiAgICAgIDxidXR0b24gY2xhc3M9ImFkZC1saW5lLWJ0biIgb25jbGljaz0iYWRkTGluZUl0ZW0oKSI+KyBBZGQgbGluZSBpdGVtPC9idXR0b24+CiAgICAgIDxkaXYgY2xhc3M9InRvdGFsLXJvdyI+PHNwYW4+VG90YWwgKENBRCk8L3NwYW4+PHNwYW4gY2xhc3M9InRvdGFsLWFtb3VudCIgaWQ9InRvdGFsRGlzcGxheSI+JDAuMDA8L3NwYW4+PC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImZpZWxkLXJvdyI+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+RHVlIERhdGUgPHNwYW4gc3R5bGU9ImZvbnQtd2VpZ2h0OjQwMDt0ZXh0LXRyYW5zZm9ybTpub25lOyI+KG9wdGlvbmFsKTwvc3Bhbj48L2xhYmVsPjxpbnB1dCB0eXBlPSJ0ZXh0IiBpZD0iZHVlRGF0ZSIgcGxhY2Vob2xkZXI9ImUuZy4gQXByaWwgNSwgMjAyNiIgb25pbnB1dD0idXBkYXRlUHJldmlldygpIiAvPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlJlZmVyZW5jZSAjIDxzcGFuIHN0eWxlPSJmb250LXdlaWdodDo0MDA7dGV4dC10cmFuc2Zvcm06bm9uZTsiPihvcHRpb25hbCk8L3NwYW4+PC9sYWJlbD48aW5wdXQgdHlwZT0idGV4dCIgaWQ9InJlZmVyZW5jZSIgcGxhY2Vob2xkZXI9IkF1dG8tZ2VuZXJhdGVkIGlmIGJsYW5rIiBvbmlucHV0PSJ1cGRhdGVQcmV2aWV3KCkiIC8+PC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+Tm90ZXMgPHNwYW4gc3R5bGU9ImZvbnQtd2VpZ2h0OjQwMDt0ZXh0LXRyYW5zZm9ybTpub25lOyI+KG9wdGlvbmFsKTwvc3Bhbj48L2xhYmVsPjx0ZXh0YXJlYSBpZD0ibm90ZXMiIHJvd3M9IjIiIHBsYWNlaG9sZGVyPSJlLmcuIFByaWNlIHZhbGlkIGZvciAxNCBkYXlzLiBFeGNsdWRlcyBkYW1hZ2UgZm91bmQgZHVyaW5nIHJlcGFpci4iIG9uaW5wdXQ9InVwZGF0ZVByZXZpZXcoKSI+PC90ZXh0YXJlYT48L2Rpdj4KICA8L2Rpdj4KCiAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICA8ZGl2IGNsYXNzPSJjYXJkLXRpdGxlIj4KICAgICAgPHN2ZyB3aWR0aD0iMTYiIGhlaWdodD0iMTYiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cmVjdCB4PSIxIiB5PSI0IiB3aWR0aD0iMjIiIGhlaWdodD0iMTYiIHJ4PSIyIiByeT0iMiIvPjxsaW5lIHgxPSIxIiB5MT0iMTAiIHgyPSIyMyIgeTI9IjEwIi8+PC9zdmc+CiAgICAgIFBheW1lbnQKICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0ic3RyaXBlLWhlbHBlciI+CiAgICAgIDxkaXYgY2xhc3M9InN0cmlwZS1oZWxwZXItdGl0bGUiPlF1aWNrIFN0cmlwZSBQYXltZW50IExpbms8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ic3RyaXBlLXN0ZXBzIj4KICAgICAgICAxLiBDbGljayA8c3Ryb25nPk9wZW4gU3RyaXBlPC9zdHJvbmc+IGJlbG93IOKAlCBnb2VzIHRvIHlvdXIgUGF5bWVudCBMaW5rcyBkYXNoYm9hcmQ8YnI+CiAgICAgICAgMi4gQ2xpY2sgPHN0cm9uZz5DcmVhdGUgbGluazwvc3Ryb25nPiwgc2V0IGFtb3VudCB0byA8c3BhbiBjbGFzcz0ic3RyaXBlLWFtdCIgaWQ9InN0cmlwZUFtb3VudEhpbnQiPiQwLjAwPC9zcGFuPiBhbmQgYWRkIGEgZGVzY3JpcHRpb248YnI+CiAgICAgICAgMy4gQ29weSB0aGUgbGluayAoc3RhcnRzIHdpdGggPGNvZGUgc3R5bGU9ImJhY2tncm91bmQ6cmdiYSgwLDAsMCwwLjA2KTtwYWRkaW5nOjFweCA1cHg7Ym9yZGVyLXJhZGl1czo0cHg7Ij5idXkuc3RyaXBlLmNvbS8uLi48L2NvZGU+KSBhbmQgcGFzdGUgYmVsb3cKICAgICAgPC9kaXY+CiAgICAgIDxhIGhyZWY9Imh0dHBzOi8vZGFzaGJvYXJkLnN0cmlwZS5jb20vcGF5bWVudC1saW5rcyIgdGFyZ2V0PSJfYmxhbmsiIGNsYXNzPSJzdHJpcGUtb3Blbi1idG4iPgogICAgICAgIDxzdmcgd2lkdGg9IjEzIiBoZWlnaHQ9IjEzIiB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIuNSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMTggMTN2NmEyIDIgMCAwIDEtMiAySDVhMiAyIDAgMCAxLTItMlY4YTIgMiAwIDAgMSAyLTJoNiIvPjxwb2x5bGluZSBwb2ludHM9IjE1IDMgMjEgMyAyMSA5Ii8+PGxpbmUgeDE9IjEwIiB5MT0iMTQiIHgyPSIyMSIgeTI9IjMiLz48L3N2Zz4KICAgICAgICBPcGVuIFN0cmlwZSBEYXNoYm9hcmQKICAgICAgPC9hPgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+CiAgICAgIDxsYWJlbD5TdHJpcGUgUGF5bWVudCBMaW5rPC9sYWJlbD4KICAgICAgPGlucHV0IHR5cGU9InVybCIgaWQ9InN0cmlwZVBheW1lbnRMaW5rIiBwbGFjZWhvbGRlcj0iaHR0cHM6Ly9idXkuc3RyaXBlLmNvbS94eHh4eHh4eCIgb25pbnB1dD0idXBkYXRlUHJldmlldygpIiAvPgogICAgICA8cCBjbGFzcz0iZmllbGQtaGludCI+UGFzdGUgdGhlIGxpbmsgZ2VuZXJhdGVkIGZyb20gU3RyaXBlIGFib3ZlLjwvcD4KICAgIDwvZGl2PgogIDwvZGl2PgoKICA8cCBjbGFzcz0icHJldmlldy1sYWJlbCI+TGl2ZSBFbWFpbCBQcmV2aWV3PC9wPgogIDxkaXYgY2xhc3M9InByZXZpZXctY2FyZCI+CiAgICA8ZGl2IGNsYXNzPSJwLWhlYWRlciI+CiAgICAgIDxkaXYgY2xhc3M9InAtbG9nbyI+SG9tZSAxMDE8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0icC1zdWIiPlF1b3RlICZhbXA7IFBheW1lbnQg4oCUIDxzcGFuIGlkPSJwLWRhdGUiPjwvc3Bhbj48L2Rpdj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0icC1iYXIiPgogICAgICA8c3BhbiBpZD0icC1yZWYiPlJFRjog4oCUPC9zcGFuPgogICAgICA8c3Bhbj5RdW90ZTwvc3Bhbj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0icC1ib2R5Ij4KICAgICAgPGRpdiBjbGFzcz0icC1tZXRhIj4KICAgICAgICA8ZGl2IGNsYXNzPSJwLW1ldGEtaXRlbSI+PHNwYW4gY2xhc3M9InAtbWV0YS1sYWJlbCI+VG88L3NwYW4+PHNwYW4gY2xhc3M9InAtbWV0YS12YWwiIGlkPSJwLW5hbWUiPuKAlDwvc3Bhbj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJwLW1ldGEtaXRlbSI+PHNwYW4gY2xhc3M9InAtbWV0YS1sYWJlbCI+RW1haWw8L3NwYW4+PHNwYW4gY2xhc3M9InAtbWV0YS12YWwiIGlkPSJwLWVtYWlsIj7igJQ8L3NwYW4+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0icC1tZXRhLWl0ZW0iPjxzcGFuIGNsYXNzPSJwLW1ldGEtbGFiZWwiPlBob25lPC9zcGFuPjxzcGFuIGNsYXNzPSJwLW1ldGEtdmFsIiBpZD0icC1waG9uZSI+4oCUPC9zcGFuPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InAtbWV0YS1pdGVtIj48c3BhbiBjbGFzcz0icC1tZXRhLWxhYmVsIj5BZGRyZXNzPC9zcGFuPjxzcGFuIGNsYXNzPSJwLW1ldGEtdmFsIiBpZD0icC1hZGRyIj7igJQ8L3NwYW4+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0icC1tZXRhLWl0ZW0iIGlkPSJwLWR1ZS13cmFwIiBzdHlsZT0iZGlzcGxheTpub25lOyI+PHNwYW4gY2xhc3M9InAtbWV0YS1sYWJlbCI+RHVlPC9zcGFuPjxzcGFuIGNsYXNzPSJwLW1ldGEtdmFsIiBpZD0icC1kdWUiPuKAlDwvc3Bhbj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJwLW1ldGEtaXRlbSI+PHNwYW4gY2xhc3M9InAtbWV0YS1sYWJlbCI+UmVmPC9zcGFuPjxzcGFuIGNsYXNzPSJwLW1ldGEtdmFsIiBpZD0icC1yZWYtaW5saW5lIj7igJQ8L3NwYW4+PC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJwLWRlc2MiIGlkPSJwLWRlc2MiPldvcmsgZGVzY3JpcHRpb24gd2lsbCBhcHBlYXIgaGVyZeKApjwvZGl2PgogICAgICA8dGFibGUgY2xhc3M9InAtbGluZXMiIGlkPSJwLWxpbmVzIj48dHI+PHRkIGNvbHNwYW49IjIiIHN0eWxlPSJjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjExcHg7cGFkZGluZzo2cHggMDsiPk5vIGxpbmUgaXRlbXMgeWV0PC90ZD48L3RyPjwvdGFibGU+CiAgICAgIDxkaXYgY2xhc3M9InAtdG90YWwtcm93Ij48c3BhbiBjbGFzcz0icC10b3RhbC1sYWJlbCI+VG90YWwgKENBRCk8L3NwYW4+PHNwYW4gY2xhc3M9InAtdG90YWwtYW10IiBpZD0icC10b3RhbCI+JDAuMDA8L3NwYW4+PC9kaXY+CiAgICAgIDxhIGNsYXNzPSJwLXBheS1idG4iIGlkPSJwLXBheWJ0biIgaHJlZj0iIyI+UGF5IE5vdyDigJQgJDAuMDA8L2E+CiAgICAgIDxwIGNsYXNzPSJwLWR1ZS1saW5lIiBpZD0icC1kdWUtbGluZSI+PC9wPgogICAgICA8ZGl2IGNsYXNzPSJwLW5vdGVzIiBpZD0icC1ub3Rlcy1ib3giPjwvZGl2PgogICAgPC9kaXY+CiAgPC9kaXY+CgogIDxkaXYgY2xhc3M9ImFjdGlvbi1yb3ciPgogICAgPGJ1dHRvbiBjbGFzcz0iYnRuLXByaW1hcnkiIGlkPSJzZW5kQnRuIiBvbmNsaWNrPSJzZW5kSW52b2ljZSgpIj4KICAgICAgPHN2ZyB3aWR0aD0iMTUiIGhlaWdodD0iMTUiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48bGluZSB4MT0iMjIiIHkxPSIyIiB4Mj0iMTEiIHkyPSIxMyIvPjxwb2x5Z29uIHBvaW50cz0iMjIgMiAxNSAyMiAxMSAxMyAyIDkgMjIgMiIvPjwvc3ZnPgogICAgICA8c3BhbiBpZD0ic2VuZFRleHQiPlNlbmQgUXVvdGUgdG8gQ3VzdG9tZXI8L3NwYW4+CiAgICAgIDxkaXYgY2xhc3M9InNwaW5uZXIiIGlkPSJzZW5kU3Bpbm5lciI+PC9kaXY+CiAgICA8L2J1dHRvbj4KICAgIDxidXR0b24gY2xhc3M9ImJ0bi1zZWNvbmRhcnkiIG9uY2xpY2s9ImRvd25sb2FkUERGKCkiPgogICAgICA8c3ZnIHdpZHRoPSIxNCIgaGVpZ2h0PSIxNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxwYXRoIGQ9Ik0yMSAxNXY0YTIgMiAwIDAgMS0yIDJINWEyIDIgMCAwIDEtMi0ydi00Ii8+PHBvbHlsaW5lIHBvaW50cz0iNyAxMCAxMiAxNSAxNyAxMCIvPjxsaW5lIHgxPSIxMiIgeTE9IjE1IiB4Mj0iMTIiIHkyPSIzIi8+PC9zdmc+CiAgICAgIERvd25sb2FkIFBERgogICAgPC9idXR0b24+CiAgPC9kaXY+CiAgPGRpdiBjbGFzcz0ic3RhdHVzLW1zZyIgaWQ9InN0YXR1c01zZyI+PC9kaXY+Cgo8L2Rpdj4KPC9kaXY+Cgo8c2NyaXB0Pgpjb25zdCBCQUNLRU5EX1VSTCA9ICcnOwoKLy8gUmVzdW1lIHNlc3Npb24gaWYgdG9rZW4gaXMgc3RpbGwgc3RvcmVkCiAgICB9CgpmdW5jdGlvbiBmbXQobikgeyByZXR1cm4gJyQnICsgTnVtYmVyKG58fDApLnRvRml4ZWQoMikucmVwbGFjZSgvXEIoPz0oXGR7M30pKyg/IVxkKSkvZywnLCcpOyB9CmZ1bmN0aW9uIGdldExpbmVJdGVtcygpIHsKICByZXR1cm4gQXJyYXkuZnJvbShkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcubGluZS1pdGVtJykpLm1hcChyID0+IHsKICAgIGNvbnN0IGkgPSByLnF1ZXJ5U2VsZWN0b3JBbGwoJ2lucHV0Jyk7CiAgICByZXR1cm4geyBsYWJlbDogaVswXS52YWx1ZS50cmltKCksIGFtb3VudDogcGFyc2VGbG9hdChpWzFdLnZhbHVlKXx8MCB9OwogIH0pLmZpbHRlcihpID0+IGkubGFiZWwgfHwgaS5hbW91bnQgPiAwKTsKfQpmdW5jdGlvbiBnZXRUb3RhbCgpIHsgcmV0dXJuIGdldExpbmVJdGVtcygpLnJlZHVjZSgocyxpKSA9PiBzK2kuYW1vdW50LCAwKTsgfQoKbGV0IGxpbmVJdGVtQ291bnQgPSAwOwpmdW5jdGlvbiBhZGRMaW5lSXRlbShsYWJlbD0nJywgYW1vdW50PScnKSB7CiAgbGluZUl0ZW1Db3VudCsrOwogIGNvbnN0IGlkID0gJ2xpLScrbGluZUl0ZW1Db3VudDsKICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTsKICByb3cuY2xhc3NOYW1lID0gJ2xpbmUtaXRlbSc7IHJvdy5pZCA9IGlkOwogIHJvdy5pbm5lckhUTUwgPSBgPGlucHV0IHR5cGU9InRleHQiIHBsYWNlaG9sZGVyPSJlLmcuIExhYm91ciDigJQgdGFwIHJlcGxhY2VtZW50IiB2YWx1ZT0iJHtsYWJlbH0iIG9uaW5wdXQ9InVwZGF0ZVByZXZpZXcoKSIgLz48aW5wdXQgdHlwZT0ibnVtYmVyIiBjbGFzcz0iYW10IiBwbGFjZWhvbGRlcj0iMC4wMCIgdmFsdWU9IiR7YW1vdW50fSIgbWluPSIwIiBzdGVwPSIwLjAxIiBvbmlucHV0PSJ1cGRhdGVQcmV2aWV3KCkiIC8+PGJ1dHRvbiBjbGFzcz0ibGluZS1pdGVtLXJlbW92ZSIgb25jbGljaz0icmVtb3ZlTGluZUl0ZW0oJyR7aWR9JykiIHRpdGxlPSJSZW1vdmUiPuKclTwvYnV0dG9uPmA7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2xpbmVJdGVtcycpLmFwcGVuZENoaWxkKHJvdyk7CiAgdXBkYXRlUHJldmlldygpOwp9CmZ1bmN0aW9uIHJlbW92ZUxpbmVJdGVtKGlkKSB7IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKGlkKT8ucmVtb3ZlKCk7IHVwZGF0ZVByZXZpZXcoKTsgfQoKZnVuY3Rpb24gdXBkYXRlUHJldmlldygpIHsKICBjb25zdCBuYW1lICAgID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2N1c3RvbWVyTmFtZScpLnZhbHVlIHx8ICfigJQnOwogIGNvbnN0IGVtYWlsICAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY3VzdG9tZXJFbWFpbCcpLnZhbHVlIHx8ICfigJQnOwogIGNvbnN0IHBob25lICAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY3VzdG9tZXJQaG9uZScpLnZhbHVlIHx8ICfigJQnOwogIGNvbnN0IGFkZHIgICAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYWRkcmVzcycpLnZhbHVlIHx8ICfigJQnOwogIGNvbnN0IGRlc2MgICAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnam9iRGVzY3JpcHRpb24nKS52YWx1ZSB8fCAnV29yayBkZXNjcmlwdGlvbiB3aWxsIGFwcGVhciBoZXJl4oCmJzsKICBjb25zdCBkdWUgICAgID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2R1ZURhdGUnKS52YWx1ZS50cmltKCk7CiAgY29uc3QgcmVmICAgICA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdyZWZlcmVuY2UnKS52YWx1ZS50cmltKCkgfHwgJ0F1dG8tZ2VuZXJhdGVkJzsKICBjb25zdCBub3RlcyAgID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ25vdGVzJykudmFsdWUudHJpbSgpOwogIGNvbnN0IHBheUxpbmsgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc3RyaXBlUGF5bWVudExpbmsnKS52YWx1ZS50cmltKCkgfHwgJyMnOwogIGNvbnN0IGl0ZW1zICAgPSBnZXRMaW5lSXRlbXMoKTsKICBjb25zdCB0b3RhbCAgID0gZ2V0VG90YWwoKTsKICBjb25zdCB0ZiAgICAgID0gZm10KHRvdGFsKTsKCiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3AtbmFtZScpLnRleHRDb250ZW50ICAgID0gbmFtZTsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncC1lbWFpbCcpLnRleHRDb250ZW50ICAgPSBlbWFpbDsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncC1waG9uZScpLnRleHRDb250ZW50ICAgPSBwaG9uZTsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncC1hZGRyJykudGV4dENvbnRlbnQgICAgPSBhZGRyOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwLXJlZicpLnRleHRDb250ZW50ICAgICA9ICdSRUY6ICcgKyByZWY7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3AtcmVmLWlubGluZScpLnRleHRDb250ZW50ID0gcmVmOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwLWRlc2MnKS50ZXh0Q29udGVudCAgICA9IGRlc2M7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3AtdG90YWwnKS50ZXh0Q29udGVudCAgID0gdGY7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RvdGFsRGlzcGxheScpLnRleHRDb250ZW50ID0gdGY7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3AtcGF5YnRuJykudGV4dENvbnRlbnQgID0gJ1BheSBOb3cg4oCUICcgKyB0ZjsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncC1wYXlidG4nKS5ocmVmICAgICAgICAgPSBwYXlMaW5rOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzdHJpcGVBbW91bnRIaW50JykudGV4dENvbnRlbnQgPSB0ZjsKCiAgY29uc3QgZHVlV3JhcCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwLWR1ZS13cmFwJyk7CiAgY29uc3QgZHVlTGluZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwLWR1ZS1saW5lJyk7CiAgaWYgKGR1ZSkgewogICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3AtZHVlJykudGV4dENvbnRlbnQgPSBkdWU7CiAgICBkdWVXcmFwLnN0eWxlLmRpc3BsYXkgPSAnJzsKICAgIGR1ZUxpbmUudGV4dENvbnRlbnQgPSAnRHVlIGJ5ICcgKyBkdWU7CiAgICBkdWVMaW5lLnN0eWxlLmRpc3BsYXkgPSAnYmxvY2snOwogIH0gZWxzZSB7CiAgICBkdWVXcmFwLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7CiAgICBkdWVMaW5lLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7CiAgfQoKICBjb25zdCBub3Rlc0JveCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwLW5vdGVzLWJveCcpOwogIGlmIChub3RlcykgeyBub3Rlc0JveC50ZXh0Q29udGVudCA9IG5vdGVzOyBub3Rlc0JveC5zdHlsZS5kaXNwbGF5ID0gJ2Jsb2NrJzsgfQogIGVsc2UgeyBub3Rlc0JveC5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnOyB9CgogIGNvbnN0IGxpbmVzRWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncC1saW5lcycpOwogIGxpbmVzRWwuaW5uZXJIVE1MID0gaXRlbXMubGVuZ3RoID09PSAwCiAgICA/ICc8dHI+PHRkIGNvbHNwYW49IjIiIHN0eWxlPSJjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjExcHg7cGFkZGluZzo2cHggMDsiPk5vIGxpbmUgaXRlbXMgeWV0PC90ZD48L3RyPicKICAgIDogaXRlbXMubWFwKGkgPT4gYDx0cj48dGQgc3R5bGU9InBhZGRpbmc6NnB4IDA7Ym9yZGVyLWJvdHRvbToxcHggc29saWQgdmFyKC0tbGluZSk7Ij4ke2kubGFiZWx9PC90ZD48dGQgc3R5bGU9InBhZGRpbmc6NnB4IDA7Ym9yZGVyLWJvdHRvbToxcHggc29saWQgdmFyKC0tbGluZSk7Ij4ke2ZtdChpLmFtb3VudCl9PC90ZD48L3RyPmApLmpvaW4oJycpOwp9CgpmdW5jdGlvbiBkb3dubG9hZFBERigpIHsKICBjb25zdCB7IGpzUERGIH0gPSB3aW5kb3cuanNwZGY7CiAgY29uc3QgZG9jID0gbmV3IGpzUERGKHsgdW5pdDonbW0nLCBmb3JtYXQ6J2E0JyB9KTsKICBjb25zdCBXID0gMjEwLCBtYXJnaW4gPSAxOCwgY1cgPSBXIC0gbWFyZ2luKjI7CgogIGNvbnN0IG5hbWUgICAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY3VzdG9tZXJOYW1lJykudmFsdWUgICB8fCAn4oCUJzsKICBjb25zdCBlbWFpbCAgID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2N1c3RvbWVyRW1haWwnKS52YWx1ZSAgfHwgJ+KAlCc7CiAgY29uc3QgcGhvbmUgICA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjdXN0b21lclBob25lJykudmFsdWUgIHx8ICcnOwogIGNvbnN0IGFkZHIgICAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYWRkcmVzcycpLnZhbHVlICAgICAgICB8fCAnJzsKICBjb25zdCBkZXNjICAgID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2pvYkRlc2NyaXB0aW9uJykudmFsdWUgfHwgJyc7CiAgY29uc3QgZHVlICAgICA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdkdWVEYXRlJykudmFsdWUgICAgICAgIHx8ICcnOwogIGNvbnN0IHJlZiAgICAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncmVmZXJlbmNlJykudmFsdWUudHJpbSgpIHx8ICgnSU5WLScrTWF0aC5mbG9vcigxMDAwMCtNYXRoLnJhbmRvbSgpKjkwMDAwKSk7CiAgY29uc3Qgbm90ZXMgICA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdub3RlcycpLnZhbHVlLnRyaW0oKSAgIHx8ICcnOwogIGNvbnN0IHBheUxpbmsgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc3RyaXBlUGF5bWVudExpbmsnKS52YWx1ZS50cmltKCkgfHwgJyc7CiAgY29uc3QgaXRlbXMgICA9IGdldExpbmVJdGVtcygpOwogIGNvbnN0IHRvdGFsICAgPSBnZXRUb3RhbCgpOwogIGNvbnN0IGlzc3VlZCAgPSBuZXcgRGF0ZSgpLnRvTG9jYWxlRGF0ZVN0cmluZygnZW4tQ0EnLHt5ZWFyOidudW1lcmljJyxtb250aDonbG9uZycsZGF5OidudW1lcmljJ30pOwoKICBsZXQgeSA9IDA7CgogIC8vIERhcmsgaGVhZGVyCiAgZG9jLnNldEZpbGxDb2xvcigyOCwyOCwyOCk7IGRvYy5yZWN0KDAsMCxXLDI4LCdGJyk7CiAgZG9jLnNldFRleHRDb2xvcigyNTUsMjU1LDI1NSk7IGRvYy5zZXRGb250KCdoZWx2ZXRpY2EnLCdib2xkJyk7IGRvYy5zZXRGb250U2l6ZSgxNik7CiAgZG9jLnRleHQoJ0hvbWUgMTAxJywgbWFyZ2luLCAxMyk7CiAgZG9jLnNldEZvbnQoJ2hlbHZldGljYScsJ25vcm1hbCcpOyBkb2Muc2V0Rm9udFNpemUoOCk7IGRvYy5zZXRUZXh0Q29sb3IoMTcwLDE3MCwxNzApOwogIGRvYy50ZXh0KCdRdW90ZSAmIFBheW1lbnQg4oCUIElzc3VlZCAnK2lzc3VlZCwgbWFyZ2luLCAyMSk7CiAgeSA9IDI4OwoKICAvLyBHb2xkIGJhcgogIGRvYy5zZXRGaWxsQ29sb3IoMjAwLDE0Niw0Mik7IGRvYy5yZWN0KDAseSxXLDEyLCdGJyk7CiAgZG9jLnNldFRleHRDb2xvcigyNTUsMjU1LDI1NSk7IGRvYy5zZXRGb250KCdoZWx2ZXRpY2EnLCdib2xkJyk7IGRvYy5zZXRGb250U2l6ZSgxMCk7CiAgZG9jLnRleHQoJ1JFRjogJytyZWYsIG1hcmdpbiwgeSs4KTsKICBkb2Muc2V0Rm9udFNpemUoOSk7IGRvYy50ZXh0KCdRdW90ZScsIFctbWFyZ2luLCB5KzgsIHthbGlnbjoncmlnaHQnfSk7CiAgeSArPSAxMjsKCiAgLy8gQ3VzdG9tZXIgYmxvY2sKICB5ICs9IDEwOwogIGNvbnN0IGN1c3RMaW5lcyA9IFtlbWFpbCwgcGhvbmUsIGFkZHJdLmZpbHRlcihCb29sZWFuKTsKICBjb25zdCBjdXN0SCA9IDIyICsgY3VzdExpbmVzLmxlbmd0aCAqIDY7CiAgZG9jLnNldEZpbGxDb2xvcigyNDcsMjQ0LDIzOSk7IGRvYy5yb3VuZGVkUmVjdChtYXJnaW4seSxjVyxjdXN0SCwzLDMsJ0YnKTsKICBkb2Muc2V0VGV4dENvbG9yKDE3MCwxNzAsMTcwKTsgZG9jLnNldEZvbnRTaXplKDcuNSk7IGRvYy5zZXRGb250KCdoZWx2ZXRpY2EnLCdib2xkJyk7CiAgZG9jLnRleHQoJ1BSRVBBUkVEIEZPUicsIG1hcmdpbis1LCB5KzgpOwogIGRvYy5zZXRUZXh0Q29sb3IoMjgsMjgsMjgpOyBkb2Muc2V0Rm9udFNpemUoMTMpOwogIGRvYy50ZXh0KG5hbWUsIG1hcmdpbis1LCB5KzE2KTsKICBsZXQgY3kgPSB5KzIyOwogIGRvYy5zZXRGb250KCdoZWx2ZXRpY2EnLCdub3JtYWwnKTsgZG9jLnNldEZvbnRTaXplKDkpOyBkb2Muc2V0VGV4dENvbG9yKDgwLDgwLDgwKTsKICBjdXN0TGluZXMuZm9yRWFjaChsID0+IHsgZG9jLnRleHQobCwgbWFyZ2luKzUsIGN5KTsgY3krPTY7IH0pOwogIHkgPSBjeSArIDQ7CgogIC8vIERlc2NyaXB0aW9uCiAgaWYgKGRlc2MpIHsKICAgIHkgKz0gMjsKICAgIGRvYy5zZXRUZXh0Q29sb3IoMTcwLDE3MCwxNzApOyBkb2Muc2V0Rm9udFNpemUoNy41KTsgZG9jLnNldEZvbnQoJ2hlbHZldGljYScsJ2JvbGQnKTsKICAgIGRvYy50ZXh0KCdXT1JLIERFU0NSSVBUSU9OJywgbWFyZ2luLCB5KzIpOyB5ICs9IDY7CiAgICBjb25zdCBkTGluZXMgPSBkb2Muc3BsaXRUZXh0VG9TaXplKGRlc2MsIGNXLTgpOwogICAgY29uc3QgZEggPSBkTGluZXMubGVuZ3RoKjUrMTA7CiAgICBkb2Muc2V0RmlsbENvbG9yKDI0NywyNDQsMjM5KTsgZG9jLnJvdW5kZWRSZWN0KG1hcmdpbix5LGNXLGRILDIsMiwnRicpOwogICAgZG9jLnNldEZpbGxDb2xvcigyMDAsMTQ2LDQyKTsgZG9jLnJlY3QobWFyZ2luLHksMixkSCwnRicpOwogICAgZG9jLnNldFRleHRDb2xvcig2MCw2MCw2MCk7IGRvYy5zZXRGb250U2l6ZSg5LjUpOyBkb2Muc2V0Rm9udCgnaGVsdmV0aWNhJywnbm9ybWFsJyk7CiAgICBkb2MudGV4dChkTGluZXMsIG1hcmdpbis2LCB5KzcpOwogICAgeSArPSBkSCs4OwogIH0KCiAgLy8gTGluZSBpdGVtcwogIGRvYy5zZXRUZXh0Q29sb3IoMTcwLDE3MCwxNzApOyBkb2Muc2V0Rm9udFNpemUoNy41KTsgZG9jLnNldEZvbnQoJ2hlbHZldGljYScsJ2JvbGQnKTsKICBkb2MudGV4dCgnUVVPVEUgQlJFQUtET1dOJywgbWFyZ2luLCB5KzIpOyB5ICs9IDY7CiAgZG9jLnNldERyYXdDb2xvcigyMjAsMjE1LDIwNSk7IGRvYy5zZXRMaW5lV2lkdGgoMC4yKTsKICBpdGVtcy5mb3JFYWNoKGl0ZW0gPT4gewogICAgZG9jLnNldEZvbnQoJ2hlbHZldGljYScsJ25vcm1hbCcpOyBkb2Muc2V0Rm9udFNpemUoMTApOyBkb2Muc2V0VGV4dENvbG9yKDYwLDYwLDYwKTsKICAgIGRvYy50ZXh0KGl0ZW0ubGFiZWwsIG1hcmdpbiwgeSs2KTsKICAgIGRvYy50ZXh0KGZtdChpdGVtLmFtb3VudCksIFctbWFyZ2luLCB5KzYsIHthbGlnbjoncmlnaHQnfSk7CiAgICBkb2MubGluZShtYXJnaW4sIHkrOSwgVy1tYXJnaW4sIHkrOSk7IHkgKz0gMTA7CiAgfSk7CgogIC8vIFRvdGFsCiAgeSArPSAyOwogIGRvYy5zZXRMaW5lV2lkdGgoMC44KTsgZG9jLnNldERyYXdDb2xvcigyOCwyOCwyOCk7CiAgZG9jLmxpbmUobWFyZ2luLCB5LCBXLW1hcmdpbiwgeSk7IHkgKz0gNjsKICBkb2Muc2V0Rm9udCgnaGVsdmV0aWNhJywnYm9sZCcpOyBkb2Muc2V0Rm9udFNpemUoMTEpOyBkb2Muc2V0VGV4dENvbG9yKDI4LDI4LDI4KTsKICBkb2MudGV4dCgnVG90YWwgKENBRCknLCBtYXJnaW4sIHkpOwogIGRvYy5zZXRGb250U2l6ZSgxNSk7IGRvYy5zZXRUZXh0Q29sb3IoMjAwLDE0Niw0Mik7CiAgZG9jLnRleHQoZm10KHRvdGFsKSwgVy1tYXJnaW4sIHksIHthbGlnbjoncmlnaHQnfSk7IHkgKz0gODsKCiAgaWYgKGR1ZSkgewogICAgZG9jLnNldEZvbnQoJ2hlbHZldGljYScsJ2l0YWxpYycpOyBkb2Muc2V0Rm9udFNpemUoOSk7IGRvYy5zZXRUZXh0Q29sb3IoMTMwLDEzMCwxMzApOwogICAgZG9jLnRleHQoJ0R1ZSBieSAnK2R1ZSwgbWFyZ2luLCB5KTsgeSArPSA4OwogIH0KCiAgaWYgKG5vdGVzKSB7CiAgICB5ICs9IDQ7CiAgICBkb2Muc2V0VGV4dENvbG9yKDE3MCwxNzAsMTcwKTsgZG9jLnNldEZvbnRTaXplKDcuNSk7IGRvYy5zZXRGb250KCdoZWx2ZXRpY2EnLCdib2xkJyk7CiAgICBkb2MudGV4dCgnTk9URVMnLCBtYXJnaW4sIHkpOyB5ICs9IDU7CiAgICBjb25zdCBuTGluZXMgPSBkb2Muc3BsaXRUZXh0VG9TaXplKG5vdGVzLCBjVy02KTsKICAgIGNvbnN0IG5IID0gbkxpbmVzLmxlbmd0aCo1Kzg7CiAgICBkb2Muc2V0RmlsbENvbG9yKDI0NywyNDQsMjM5KTsgZG9jLnJvdW5kZWRSZWN0KG1hcmdpbix5LGNXLG5ILDIsMiwnRicpOwogICAgZG9jLnNldEZvbnQoJ2hlbHZldGljYScsJ25vcm1hbCcpOyBkb2Muc2V0Rm9udFNpemUoOSk7IGRvYy5zZXRUZXh0Q29sb3IoMTAwLDEwMCwxMDApOwogICAgZG9jLnRleHQobkxpbmVzLCBtYXJnaW4rNCwgeSs2KTsgeSArPSBuSCs4OwogIH0KCiAgaWYgKHBheUxpbmspIHsKICAgIHkgKz0gNDsKICAgIGRvYy5zZXRGaWxsQ29sb3IoMjgsMjgsMjgpOyBkb2Mucm91bmRlZFJlY3QobWFyZ2luLHksY1csMTQsMywzLCdGJyk7CiAgICBkb2Muc2V0VGV4dENvbG9yKDI1NSwyNTUsMjU1KTsgZG9jLnNldEZvbnQoJ2hlbHZldGljYScsJ2JvbGQnKTsgZG9jLnNldEZvbnRTaXplKDExKTsKICAgIGRvYy50ZXh0KCdQYXkgTm93IOKAlCAnK2ZtdCh0b3RhbCksIFcvMiwgeSs5LjUsIHthbGlnbjonY2VudGVyJ30pOwogICAgZG9jLmxpbmsobWFyZ2luLCB5LCBjVywgMTQsIHt1cmw6IHBheUxpbmt9KTsKICAgIHkgKz0gMTg7CiAgICBkb2Muc2V0Rm9udCgnaGVsdmV0aWNhJywnbm9ybWFsJyk7IGRvYy5zZXRGb250U2l6ZSg4KTsgZG9jLnNldFRleHRDb2xvcigxNTAsMTUwLDE1MCk7CiAgICBkb2MudGV4dCgnU2VjdXJlIHBheW1lbnQgcG93ZXJlZCBieSBTdHJpcGUnLCBXLzIsIHksIHthbGlnbjonY2VudGVyJ30pOwogIH0KCiAgLy8gRm9vdGVyCiAgZG9jLnNldEZpbGxDb2xvcigyNDcsMjQ0LDIzOSk7IGRvYy5yZWN0KDAsMjgzLFcsMTQsJ0YnKTsKICBkb2Muc2V0Rm9udCgnaGVsdmV0aWNhJywnbm9ybWFsJyk7IGRvYy5zZXRGb250U2l6ZSg4KTsgZG9jLnNldFRleHRDb2xvcigxNTAsMTUwLDE1MCk7CiAgZG9jLnRleHQoJ1F1ZXN0aW9ucz8gUmVwbHkgdG8gdGhpcyBxdW90ZSBvciBjb250YWN0IEhvbWUgMTAxIOKAlCBDYWxnYXJ5LCBBQicsIG1hcmdpbiwgMjkxKTsKCiAgY29uc3Qgc2FmZU5hbWUgPSBuYW1lLnJlcGxhY2UoL1teYS16MC05XS9naSwnXycpLnRvTG93ZXJDYXNlKCk7CiAgZG9jLnNhdmUoJ0hvbWUxMDFfUXVvdGVfJytyZWYrJ18nK3NhZmVOYW1lKycucGRmJyk7Cn0KCmFzeW5jIGZ1bmN0aW9uIHNlbmRJbnZvaWNlKCkgewogIGNvbnN0IG5hbWUgICAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY3VzdG9tZXJOYW1lJykudmFsdWUudHJpbSgpOwogIGNvbnN0IGVtYWlsICAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY3VzdG9tZXJFbWFpbCcpLnZhbHVlLnRyaW0oKTsKICBjb25zdCBkZXNjICAgID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2pvYkRlc2NyaXB0aW9uJykudmFsdWUudHJpbSgpOwogIGNvbnN0IHBheUxpbmsgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc3RyaXBlUGF5bWVudExpbmsnKS52YWx1ZS50cmltKCk7CiAgY29uc3Qgc3RhdHVzRWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc3RhdHVzTXNnJyk7CgogIGNvbnN0IHNob3cgPSAobXNnLCB0eXBlKSA9PiB7CiAgICBzdGF0dXNFbC5pbm5lckhUTUwgPSBtc2c7IHN0YXR1c0VsLmNsYXNzTmFtZSA9ICdzdGF0dXMtbXNnICcrdHlwZTsKICAgIHN0YXR1c0VsLnN0eWxlLmRpc3BsYXkgPSAnYmxvY2snOwogICAgc3RhdHVzRWwuc2Nyb2xsSW50b1ZpZXcoe2JlaGF2aW9yOidzbW9vdGgnLGJsb2NrOiduZWFyZXN0J30pOwogIH07CgogIGlmICghbmFtZSkgICAgcmV0dXJuIHNob3coJ1BsZWFzZSBlbnRlciB0aGUgY3VzdG9tZXIgbmFtZS4nLCAnZXJyb3InKTsKICBpZiAoIWVtYWlsIHx8ICEvXlteXHNAXStAW15cc0BdK1wuW15cc0BdKyQvLnRlc3QoZW1haWwpKSByZXR1cm4gc2hvdygnUGxlYXNlIGVudGVyIGEgdmFsaWQgY3VzdG9tZXIgZW1haWwuJywgJ2Vycm9yJyk7CiAgaWYgKCFkZXNjKSAgICByZXR1cm4gc2hvdygnUGxlYXNlIGVudGVyIGEgd29yayBkZXNjcmlwdGlvbi4nLCAnZXJyb3InKTsKICBpZiAoIXBheUxpbmspIHJldHVybiBzaG93KCdQbGVhc2UgZW50ZXIgdGhlIFN0cmlwZSBQYXltZW50IExpbmsgVVJMLicsICdlcnJvcicpOwogIGlmIChnZXRMaW5lSXRlbXMoKS5sZW5ndGggPT09IDApIHJldHVybiBzaG93KCdQbGVhc2UgYWRkIGF0IGxlYXN0IG9uZSBsaW5lIGl0ZW0uJywgJ2Vycm9yJyk7CgogIGNvbnN0IGJ0biA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzZW5kQnRuJyk7CiAgY29uc3QgdHh0ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3NlbmRUZXh0Jyk7CiAgY29uc3Qgc3BpbiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzZW5kU3Bpbm5lcicpOwogIGJ0bi5kaXNhYmxlZD10cnVlOyB0eHQudGV4dENvbnRlbnQ9J1NlbmRpbmfigKYnOyBzcGluLnN0eWxlLmRpc3BsYXk9J2Jsb2NrJzsKICBzdGF0dXNFbC5zdHlsZS5kaXNwbGF5PSdub25lJzsKCiAgdHJ5IHsKICAgIGNvbnN0IHRva2VuID0gICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKEJBQ0tFTkRfVVJMKycvYXBpL2ludm9pY2UnLCB7CiAgICAgIG1ldGhvZDonUE9TVCcsCiAgICAgIGhlYWRlcnM6eydDb250ZW50LVR5cGUnOidhcHBsaWNhdGlvbi9qc29uJywgJ0F1dGhvcml6YXRpb24nOidCZWFyZXIgJyt0b2tlbn0sCiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsKICAgICAgICBjdXN0b21lck5hbWU6ICAgICAgbmFtZSwKICAgICAgICBjdXN0b21lckVtYWlsOiAgICAgZW1haWwsCiAgICAgICAgY3VzdG9tZXJQaG9uZTogICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjdXN0b21lclBob25lJykudmFsdWUudHJpbSgpLAogICAgICAgIGFkZHJlc3M6ICAgICAgICAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYWRkcmVzcycpLnZhbHVlLnRyaW0oKSwKICAgICAgICBqb2JEZXNjcmlwdGlvbjogICAgZGVzYywKICAgICAgICBsaW5lSXRlbXM6ICAgICAgICAgZ2V0TGluZUl0ZW1zKCksCiAgICAgICAgc3RyaXBlUGF5bWVudExpbms6IHBheUxpbmssCiAgICAgICAgZHVlRGF0ZTogICAgICAgICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdkdWVEYXRlJykudmFsdWUudHJpbSgpLAogICAgICAgIHJlZmVyZW5jZTogICAgICAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncmVmZXJlbmNlJykudmFsdWUudHJpbSgpLAogICAgICAgIG5vdGVzOiAgICAgICAgICAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbm90ZXMnKS52YWx1ZS50cmltKCksCiAgICAgIH0pLAogICAgfSk7CiAgICBjb25zdCBkYXRhID0gYXdhaXQgcmVzLmpzb24oKTsKICAgIGlmIChyZXMuc3RhdHVzID09PSA0MDEpIHsKICAgICAgICAgICAgbG9jYXRpb24ucmVsb2FkKCk7IC8vIHNlc3Npb24gZXhwaXJlZCDigJQgc2hvdyBsb2NrIHNjcmVlbiBhZ2FpbgogICAgICByZXR1cm47CiAgICB9CiAgICBpZiAoIXJlcy5vaykgdGhyb3cgbmV3IEVycm9yKGRhdGEuZXJyb3J8fCdTb21ldGhpbmcgd2VudCB3cm9uZy4nKTsKICAgIHNob3coJ1F1b3RlIHNlbnQgdG8gPHN0cm9uZz4nK2VtYWlsKyc8L3N0cm9uZz4g4oCUIFJlZmVyZW5jZTogPHN0cm9uZz4nK2RhdGEucmVmZXJlbmNlKyc8L3N0cm9uZz4nLCAnc3VjY2VzcycpOwogIH0gY2F0Y2goZXJyKSB7CiAgICBzaG93KGVyci5tZXNzYWdlfHwnRmFpbGVkIHRvIHNlbmQuIENoZWNrIHlvdXIgY29ubmVjdGlvbiBhbmQgdHJ5IGFnYWluLicsICdlcnJvcicpOwogIH0gZmluYWxseSB7CiAgICBidG4uZGlzYWJsZWQ9ZmFsc2U7IHR4dC50ZXh0Q29udGVudD0nU2VuZCBRdW90ZSB0byBDdXN0b21lcic7IHNwaW4uc3R5bGUuZGlzcGxheT0nbm9uZSc7CiAgfQp9CgpmdW5jdGlvbiBpbml0KCkgewogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwLWRhdGUnKS50ZXh0Q29udGVudCA9IG5ldyBEYXRlKCkudG9Mb2NhbGVEYXRlU3RyaW5nKCdlbi1DQScse3llYXI6J251bWVyaWMnLG1vbnRoOidsb25nJyxkYXk6J251bWVyaWMnfSk7CiAgY29uc3QgcCA9IG5ldyBVUkxTZWFyY2hQYXJhbXMod2luZG93LmxvY2F0aW9uLnNlYXJjaCk7CiAgY29uc3Qgc2V0ID0gKGlkLHZhbCkgPT4geyBpZih2YWwpIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKGlkKS52YWx1ZT12YWw7IH07CiAgc2V0KCdjdXN0b21lck5hbWUnLCAgIHAuZ2V0KCduYW1lJykpOwogIHNldCgnY3VzdG9tZXJFbWFpbCcsICBwLmdldCgnZW1haWwnKSk7CiAgc2V0KCdjdXN0b21lclBob25lJywgIHAuZ2V0KCdwaG9uZScpKTsKICBzZXQoJ2FkZHJlc3MnLCAgICAgICAgcC5nZXQoJ2FkZHJlc3MnKSk7CiAgc2V0KCdyZWZlcmVuY2UnLCAgICAgIHAuZ2V0KCdyZWYnKSk7CiAgc2V0KCdqb2JEZXNjcmlwdGlvbicsIHAuZ2V0KCdqb2InKSk7CiAgaWYgKHAuZ2V0KCduYW1lJykpIHsKICAgIGNvbnN0IGIgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncHJlZmlsbEJhbm5lcicpOwogICAgYi5pbm5lckhUTUwgPSAnPHN0cm9uZz5QcmUtZmlsbGVkPC9zdHJvbmc+IGZyb20gc2VydmljZSByZXF1ZXN0ICcrKHAuZ2V0KCdyZWYnKXx8JycpKycg4oCUIHJldmlldyBkZXRhaWxzLCBhZGQgbGluZSBpdGVtcywgdGhlbiBzZW5kLic7CiAgICBiLnN0eWxlLmRpc3BsYXkgPSAnYmxvY2snOwogIH0KICBhZGRMaW5lSXRlbSgpOwogIHVwZGF0ZVByZXZpZXcoKTsKfQoKPC9zY3JpcHQ+CjwvYm9keT4KPC9odG1sPg==';

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
