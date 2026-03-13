require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const multer     = require('multer');
const { Resend } = require('resend');

const app    = express();
const resend = new Resend(process.env.RESEND_API_KEY);
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024, files: 6 },
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
app.use(express.json());

// ── POST /api/request ──────────────────────────────────────────────────────────
app.post('/api/request', upload.array('photos', 6), async (req, res) => {
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
  <tr><td style="background:#f7f4ef;padding:20px 36px;border-top:1px solid rgba(0,0,0,0.06);">
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

app.get('/health', (_, res) => res.json({ status: 'ok' }));

// Listen locally in dev; export for Vercel serverless in production
if (require.main === module) {
  app.listen(PORT, () => console.log(`Home 101 API running on http://localhost:${PORT}`));
}
module.exports = app;
