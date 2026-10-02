/* ============================================================
   EMAIL — used for the seller verification codes.

   Any SMTP provider works (Gmail, Mailgun, SendGrid, Brevo, Resend,
   your own host): set SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASS
   in .env and that is the whole setup.

   With SMTP left unconfigured the store still runs: codes are
   printed to the server console instead of being emailed, so the
   whole flow is testable locally. A code is never returned in an
   HTTP response, so a store accidentally deployed without SMTP
   fails closed rather than handing codes to whoever asks.
   ============================================================ */
const storeConfig = require('./store.config');

let transport = null;
let transportError = null;

function smtpConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_PORT);
}

/* nodemailer is only loaded when SMTP is actually configured, so a
   deployment that does not send email carries no cost for it. */
function getTransport() {
  if (transport || transportError) return transport;
  try {
    const nodemailer = require('nodemailer');
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT),
      // Port 465 is implicit TLS; 587 and 25 upgrade with STARTTLS.
      secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : Number(process.env.SMTP_PORT) === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  } catch (error) {
    transportError = error;
    console.error('SMTP is configured but nodemailer could not be loaded:', error.message);
  }
  return transport;
}

function fromAddress() {
  return process.env.MAIL_FROM || `${storeConfig.name} <no-reply@localhost>`;
}

/* Resolves to true when the message was handed to an SMTP server.
   Callers must treat false as "not delivered" and say so, rather than
   claiming an email is on its way. */
async function sendMail({ to, subject, text, html }) {
  if (!smtpConfigured()) {
    console.warn(
      `\n[email not configured] Would have sent to ${to}\n  Subject: ${subject}\n  ${String(text).replace(/\n/g, '\n  ')}\n` +
      '  Set SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS in .env to send this for real.\n'
    );
    return false;
  }
  const mailer = getTransport();
  if (!mailer) return false;
  try {
    await mailer.sendMail({ from: fromAddress(), to, subject, text, html });
    return true;
  } catch (error) {
    console.error(`Could not send email to ${to}:`, error.message);
    return false;
  }
}

/* The verification email. Plain text carries the code on its own line
   so it survives any client, and the HTML version is deliberately
   simple - no images, no external CSS, nothing to get blocked. */
async function sendSellerOtpEmail(to, code, minutes) {
  const store = storeConfig.name;
  const text = `Your ${store} seller verification code is:\n\n${code}\n\nIt expires in ${minutes} minutes. If you did not request it, you can ignore this email.`;
  const html = `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:480px">
  <p style="font-size:15px;color:#27323a">Use this code to verify your seller account on <strong>${store}</strong>:</p>
  <p style="font-size:30px;font-weight:700;letter-spacing:6px;margin:20px 0;color:#1d2933">${code}</p>
  <p style="font-size:13px;color:#6b7680">It expires in ${minutes} minutes. If you did not request it, you can ignore this email.</p>
</div>`;
  return sendMail({ to, subject: `Your ${store} verification code`, text, html });
}

module.exports = { sendMail, sendSellerOtpEmail, smtpConfigured };
