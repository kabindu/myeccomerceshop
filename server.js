require('dotenv').config();

const express = require('express');
const compression = require('compression');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Pool } = require('pg');
const { put, del } = require('@vercel/blob');
const sharp = require('sharp');
const storeConfig = require('./store.config');
const { sendSellerOtpEmail, smtpConfigured } = require('./mailer');

const app = express();
app.use(compression());
const port = Number(process.env.PORT || 3000);
const uploadDirectory = process.env.VERCEL ? path.join('/tmp', 'store-uploads') : path.join(__dirname, 'uploads');
fs.mkdirSync(uploadDirectory, { recursive: true });

const pool = new Pool(process.env.DATABASE_URL ? {
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  keepAlive: true,
} : {
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'mystore',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || process.env.PG_PASSWORD || '',
  ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : undefined,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  keepAlive: true,
});

pool.on('error', error => console.error('PostgreSQL pool error:', error.message));

const upload = multer({
  storage: process.env.VERCEL ? multer.memoryStorage() : multer.diskStorage({
    destination: uploadDirectory,
    filename: (_request, file, callback) => {
      const extension = path.extname(file.originalname).toLowerCase();
      callback(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${extension}`);
    },
  }),
  fileFilter: (_request, file, callback) => callback(null, file.mimetype.startsWith('image/')),
  limits: { fileSize: 5 * 1024 * 1024 },
});
const uploadProductImages = upload.fields([{ name: 'image', maxCount: 1 }, { name: 'image2', maxCount: 1 }, { name: 'image3', maxCount: 1 }]);

app.use(express.json());

/* ============================================================
   SECRETS — every one of these comes from the environment, so a
   fresh clone has no usable credentials baked into it. See
   .env.example for the full list.
   ============================================================ */
const adminCredentials = {
  username: process.env.ADMIN_USERNAME || '',
  password: process.env.ADMIN_PASSWORD || '',
};
const adminConfigured = Boolean(adminCredentials.username && adminCredentials.password);
if (!adminConfigured) console.warn('ADMIN_USERNAME / ADMIN_PASSWORD are not set - the admin dashboard is locked until they are.');

/* A random fallback keeps a fresh clone runnable without any setup,
   at the cost of signing everyone out on restart (and, on serverless,
   per instance) - which is why startup says so out loud. */
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) console.warn('SESSION_SECRET is not set - using a temporary one, so customer and seller logins will not survive a restart.');

const sessionCookie = 'store_admin';
const sessionLifetime = 8 * 60 * 60 * 1000;

function sessionToken(username, expiresAt) {
  const payload = `${username}:${expiresAt}`;
  const signature = crypto.createHmac('sha256', adminCredentials.password).update(payload).digest('hex');
  return `${Buffer.from(payload).toString('base64url')}.${signature}`;
}

function getCookies(request) {
  return Object.fromEntries((request.headers.cookie || '').split(';').filter(Boolean).map(cookie => {
    const separator = cookie.indexOf('=');
    return [cookie.slice(0, separator).trim(), decodeURIComponent(cookie.slice(separator + 1))];
  }));
}

function isAuthenticated(request) {
  if (!adminConfigured) return false;
  const cookies = getCookies(request);
  const [encodedPayload, signature] = (cookies[sessionCookie] || '').split('.');
  if (!encodedPayload || !signature) return false;
  const payload = Buffer.from(encodedPayload, 'base64url').toString('utf8');
  const expectedSignature = crypto.createHmac('sha256', adminCredentials.password).update(payload).digest('hex');
  if (signature.length !== expectedSignature.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) return false;
  const [username, expiresAt] = payload.split(':');
  return username === adminCredentials.username && Number(expiresAt) > Date.now();
}

function requireAdmin(request, response, next) {
  if (isAuthenticated(request)) return next();
  if (request.path === '/' || request.path.endsWith('.html')) return response.redirect('/admin/login');
  response.status(401).json({ error: 'Admin authentication required.' });
}

app.get('/admin/login', (_request, response) => response.sendFile(path.join(__dirname, 'admin', 'login.html')));
app.post('/admin/login', (request, response) => {
  if (!adminConfigured) return response.status(503).json({ error: 'Admin access is not configured. Set ADMIN_USERNAME and ADMIN_PASSWORD in your .env file.' });
  const { username, password } = request.body || {};
  if (username !== adminCredentials.username || password !== adminCredentials.password) return response.status(401).json({ error: 'Invalid username or password.' });
  const expiresAt = Date.now() + sessionLifetime;
  response.set('Set-Cookie', `${sessionCookie}=${encodeURIComponent(sessionToken(username, expiresAt))}; HttpOnly; SameSite=Lax; ${process.env.VERCEL ? 'Secure; ' : ''}Path=/; Max-Age=${sessionLifetime / 1000}`);
  response.json({ ok: true });
});
app.post('/admin/logout', requireAdmin, (_request, response) => {
  response.set('Set-Cookie', `${sessionCookie}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  response.sendStatus(204);
});

/* ============================================================
   CUSTOMER ACCOUNTS — deliberately lightweight: no email
   verification, no password reset flow, just register/login/logout
   backed by a signed cookie (same approach as the admin session
   above). Lets checkout attach orders to an account, and lets the
   header show who's signed in.
   ============================================================ */
const customerSessionCookie = 'store_customer';
const customerSessionLifetime = 30 * 24 * 60 * 60 * 1000; // 30 days — customers should stay signed in across visits
const customerSessionSecret = sessionSecret;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function customerSessionToken(customerId, expiresAt) {
  const payload = `${customerId}:${expiresAt}`;
  const signature = crypto.createHmac('sha256', customerSessionSecret).update(payload).digest('hex');
  return `${Buffer.from(payload).toString('base64url')}.${signature}`;
}

function currentCustomerId(request) {
  const cookies = getCookies(request);
  const [encodedPayload, signature] = (cookies[customerSessionCookie] || '').split('.');
  if (!encodedPayload || !signature) return null;
  const payload = Buffer.from(encodedPayload, 'base64url').toString('utf8');
  const expectedSignature = crypto.createHmac('sha256', customerSessionSecret).update(payload).digest('hex');
  if (signature.length !== expectedSignature.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) return null;
  const [customerId, expiresAt] = payload.split(':');
  if (Number(expiresAt) <= Date.now()) return null;
  return Number(customerId);
}

function setCustomerSessionCookie(response, customerId) {
  const expiresAt = Date.now() + customerSessionLifetime;
  response.set('Set-Cookie', `${customerSessionCookie}=${encodeURIComponent(customerSessionToken(customerId, expiresAt))}; HttpOnly; SameSite=Lax; ${process.env.VERCEL ? 'Secure; ' : ''}Path=/; Max-Age=${customerSessionLifetime / 1000}`);
}

app.post('/api/account/register', async (request, response) => {
  const name = String(request.body?.name || '').trim();
  const email = String(request.body?.email || '').trim().toLowerCase();
  const phone = normalizePhone(request.body?.phone);
  const password = String(request.body?.password || '');
  if (!name || !email || !password) return response.status(400).json({ error: 'Name, email, and password are required.' });
  if (name.length < 2) return response.status(400).json({ error: 'Enter your full name.' });
  if (!isValidEmail(email)) return response.status(400).json({ error: 'Enter a valid email address.' });
  if (!phone) return response.status(400).json({ error: 'Enter a valid phone number, including the country code.' });
  if (password.length < 6) return response.status(400).json({ error: 'Password must be at least 6 characters.' });
  try {
    const result = await queryWithRetry(
      'INSERT INTO customers (name, email, phone, password_hash) VALUES ($1,$2,$3,$4) RETURNING id, name, email, phone',
      [name, email, phone, hashPassword(password)]
    );
    const customer = result.rows[0];
    setCustomerSessionCookie(response, customer.id);
    response.status(201).json(customer);
  } catch (error) {
    if (error.code === '23505') return response.status(409).json({ error: 'An account with that email already exists.' });
    console.error('Register error:', error);
    response.status(500).json({ error: 'Could not create your account.' });
  }
});

app.post('/api/account/login', async (request, response) => {
  const email = String(request.body?.email || '').trim().toLowerCase();
  const password = String(request.body?.password || '');
  if (!email || !password) return response.status(400).json({ error: 'Email and password are required.' });
  try {
    const result = await queryWithRetry('SELECT id, name, email, phone, password_hash FROM customers WHERE email = $1', [email]);
    const customer = result.rows[0];
    if (!customer || !verifyPassword(password, customer.password_hash)) return response.status(401).json({ error: 'Invalid email or password.' });
    setCustomerSessionCookie(response, customer.id);
    response.json({ id: customer.id, name: customer.name, email: customer.email, phone: customer.phone });
  } catch (error) {
    console.error('Login error:', error);
    response.status(500).json({ error: 'Could not sign you in.' });
  }
});

app.post('/api/account/logout', (_request, response) => {
  response.set('Set-Cookie', `${customerSessionCookie}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  response.sendStatus(204);
});

app.get('/api/account/me', async (request, response) => {
  const customerId = currentCustomerId(request);
  if (!customerId) return response.status(401).json({ error: 'Not signed in.' });
  try {
    const result = await queryWithRetry('SELECT id, name, email, phone, cart FROM customers WHERE id = $1', [customerId]);
    if (!result.rowCount) return response.status(401).json({ error: 'Not signed in.' });
    response.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    response.status(500).json({ error: 'Could not load your account.' });
  }
});

/* Mirrors a signed-in customer's cart server-side (best-effort - the
   storefront still works entirely off localStorage if this fails) so
   admin can see who has items sitting in their cart and follow up
   directly, since there's no other record of a cart that never became
   an order. */
async function saveCustomerCart(customerId, items) {
  if (!customerId) return;
  await queryWithRetry('UPDATE customers SET cart = $2, cart_updated_at = NOW() WHERE id = $1', [customerId, JSON.stringify(items)]);
}

app.post('/api/account/cart', async (request, response) => {
  const customerId = currentCustomerId(request);
  if (!customerId) return response.sendStatus(401);
  const items = Array.isArray(request.body?.items) ? request.body.items.slice(0, 100).map(item => ({
    productId: Number(item.productId),
    qty: Math.max(1, Number(item.qty) || 1),
  })).filter(item => Number.isFinite(item.productId)) : [];
  try {
    await saveCustomerCart(customerId, items);
    response.sendStatus(204);
  } catch (error) {
    console.error(error);
    response.status(500).json({ error: 'Could not save your cart.' });
  }
});

app.get('/api/account/orders', async (request, response) => {
  const customerId = currentCustomerId(request);
  if (!customerId) return response.status(401).json({ error: 'Not signed in.' });
  try {
    const result = await queryWithRetry(
      'SELECT id, items, subtotal, status, created_at FROM orders WHERE customer_id = $1 ORDER BY created_at DESC',
      [customerId]
    );
    response.json({ orders: result.rows });
  } catch (error) {
    console.error(error);
    response.status(500).json({ error: 'Could not load your orders.' });
  }
});

/* ============================================================
   SELLER ACCOUNTS — a shop applies via the storefront's "Sell with
   us" link, lands as status='pending', and can't sign in until admin
   approves them from the Sellers view in /admin. Once active, they
   get their own scoped dashboard at /seller to manage only their own
   products - everything else (categories, brands, other sellers'
   listings, orders) stays admin-only.
   ============================================================ */
const sellerSessionCookie = 'store_seller';
const sellerSessionLifetime = 14 * 24 * 60 * 60 * 1000; // 14 days
const sellerSessionSecret = `${sessionSecret}:seller`;

function sellerSessionToken(sellerId, expiresAt) {
  const payload = `${sellerId}:${expiresAt}`;
  const signature = crypto.createHmac('sha256', sellerSessionSecret).update(payload).digest('hex');
  return `${Buffer.from(payload).toString('base64url')}.${signature}`;
}

function currentSellerId(request) {
  const cookies = getCookies(request);
  const [encodedPayload, signature] = (cookies[sellerSessionCookie] || '').split('.');
  if (!encodedPayload || !signature) return null;
  const payload = Buffer.from(encodedPayload, 'base64url').toString('utf8');
  const expectedSignature = crypto.createHmac('sha256', sellerSessionSecret).update(payload).digest('hex');
  if (signature.length !== expectedSignature.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) return null;
  const [sellerId, expiresAt] = payload.split(':');
  if (Number(expiresAt) <= Date.now()) return null;
  return Number(sellerId);
}

function setSellerSessionCookie(response, sellerId) {
  const expiresAt = Date.now() + sellerSessionLifetime;
  response.set('Set-Cookie', `${sellerSessionCookie}=${encodeURIComponent(sellerSessionToken(sellerId, expiresAt))}; HttpOnly; SameSite=Lax; ${process.env.VERCEL ? 'Secure; ' : ''}Path=/; Max-Age=${sellerSessionLifetime / 1000}`);
}

function requireSellerPage(request, response, next) {
  if (currentSellerId(request)) return next();
  return response.redirect('/seller/login.html');
}

/* ============================================================
   SELLER VERIFICATION - Google sign-in and emailed codes

   Both are independent of admin approval on purpose: a verified
   seller still waits for you to approve them, and you can approve
   someone who has not verified. Verification tells you an email and
   an identity are real; approval is you deciding who may sell.
   ============================================================ */
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const oauthStateCookie = 'store_oauth_state';
const googlePendingCookie = 'store_google_pending';

const OTP_LENGTH = 6;
const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_SECONDS = 60;

function googleConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

/* Must match a redirect URI registered in the Google Cloud console
   exactly. Derived from the request so local development and a
   deployed host both work with no extra setup, with an override for
   anything sitting behind a proxy that rewrites the host. */
function googleRedirectUri(request) {
  if (process.env.GOOGLE_REDIRECT_URI) return process.env.GOOGLE_REDIRECT_URI;
  const proto = request.headers['x-forwarded-proto'] || (process.env.VERCEL ? 'https' : request.protocol);
  const host = request.headers['x-forwarded-host'] || request.headers.host;
  return `${proto}://${host}/api/seller/auth/google/callback`;
}

function setShortCookie(response, name, value, maxAgeSeconds) {
  response.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; ${process.env.VERCEL ? 'Secure; ' : ''}Path=/; Max-Age=${maxAgeSeconds}`);
}
function clearCookie(response, name) {
  response.append('Set-Cookie', `${name}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

/* Signed with the server secret and carrying its own expiry, so an
   identity Google has just vouched for survives one redirect without
   being stored anywhere or being editable in the browser. */
function signPayload(payload, lifetimeMs) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + lifetimeMs })).toString('base64url');
  const signature = crypto.createHmac('sha256', sessionSecret).update(body).digest('hex');
  return `${body}.${signature}`;
}
function readSignedPayload(token) {
  const [body, signature] = String(token || '').split('.');
  if (!body || !signature) return null;
  const expected = crypto.createHmac('sha256', sessionSecret).update(body).digest('hex');
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload.exp > Date.now() ? payload : null;
  } catch (error) { return null; }
}

/* The id_token arrives straight from the Google token endpoint over a
   server-to-server TLS call, so its payload can be read without
   re-verifying the signature - Google documents this for the
   authorization-code flow. A token arriving any other way could not be
   trusted this way. */
function readIdTokenClaims(idToken) {
  const segments = String(idToken || '').split('.');
  if (segments.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
  } catch (error) { return null; }
}

function generateOtp() {
  return String(crypto.randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, '0');
}
/* A six-digit code is trivial to brute force if it ever leaked, so only
   a keyed hash of it is stored - never the code itself. */
function hashOtp(code) {
  return crypto.createHmac('sha256', sessionSecret).update(String(code)).digest('hex');
}
function otpMatches(code, storedHash) {
  if (!storedHash) return false;
  const candidate = Buffer.from(hashOtp(code));
  const expected = Buffer.from(storedHash);
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

app.get('/api/seller/auth/google', (request, response) => {
  if (!googleConfigured()) return response.status(503).send('Google sign-in is not configured for this store.');
  const state = crypto.randomBytes(16).toString('hex');
  setShortCookie(response, oauthStateCookie, state, 600);
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set('client_id', process.env.GOOGLE_CLIENT_ID);
  url.searchParams.set('redirect_uri', googleRedirectUri(request));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  // Always show the chooser: sellers often have more than one Google account.
  url.searchParams.set('prompt', 'select_account');
  response.redirect(url.toString());
});

app.get('/api/seller/auth/google/callback', async (request, response) => {
  const fail = reason => response.redirect(`/seller/login.html?notice=${reason}`);
  if (!googleConfigured()) return fail('google-unavailable');
  // Without this check, a link planted elsewhere could complete a sign-in
  // in a visitor browser using an authorization code that is not theirs.
  const expectedState = getCookies(request)[oauthStateCookie];
  clearCookie(response, oauthStateCookie);
  if (!request.query.state || !expectedState || request.query.state !== expectedState) return fail('google-state');
  if (!request.query.code) return fail('google-cancelled');

  try {
    const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(request.query.code),
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: googleRedirectUri(request),
        grant_type: 'authorization_code',
      }),
    });
    const tokenData = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || !tokenData.id_token) {
      console.error('Google token exchange failed:', tokenData.error_description || tokenData.error || tokenResponse.status);
      return fail('google-failed');
    }
    const claims = readIdTokenClaims(tokenData.id_token);
    if (!claims || !claims.sub || !claims.email) return fail('google-failed');
    // Google hands over an unverified address on some account types, and
    // treating that as proof of email would defeat the whole point.
    if (claims.email_verified === false) return fail('google-unverified');

    const email = String(claims.email).toLowerCase();
    const existing = await queryWithRetry(
      'SELECT id, status, google_id, email_verified_at FROM sellers WHERE google_id = $1 OR email = $2 LIMIT 1',
      [claims.sub, email]
    );

    if (existing.rowCount) {
      const seller = existing.rows[0];
      // Links Google to an account that registered with a password, and
      // records the email as verified now that Google has vouched for it.
      await queryWithRetry(
        'UPDATE sellers SET google_id = COALESCE(google_id, $2), email_verified_at = COALESCE(email_verified_at, NOW()), updated_at = NOW() WHERE id = $1',
        [seller.id, claims.sub]
      );
      if (seller.status === 'suspended') return fail('suspended');
      if (seller.status === 'pending') return fail('awaiting-approval');
      setSellerSessionCookie(response, seller.id);
      return response.redirect('/seller/index.html');
    }

    // Nobody with this identity yet. Google supplies a person name and an
    // email but not a shop name or phone, so the signup is finished on a
    // short form rather than inventing placeholder details.
    setShortCookie(response, googlePendingCookie, signPayload({
      googleId: claims.sub,
      email,
      name: claims.name || '',
    }, 30 * 60 * 1000), 1800);
    return response.redirect('/seller/login.html?google=complete');
  } catch (error) {
    console.error('Google sign-in error:', error);
    return fail('google-failed');
  }
});

/* What the browser may know about a half-finished Google signup, so the
   form can show which account it is completing. */
app.get('/api/seller/auth/google/pending', (request, response) => {
  const pending = readSignedPayload(getCookies(request)[googlePendingCookie]);
  if (!pending) return response.status(404).json({ error: 'No Google sign-up in progress.' });
  response.json({ email: pending.email, name: pending.name });
});

app.post('/api/seller/register/google', async (request, response) => {
  const pending = readSignedPayload(getCookies(request)[googlePendingCookie]);
  if (!pending) return response.status(400).json({ error: 'That Google sign-up expired. Please start again.' });
  const businessName = String(request.body?.businessName || '').trim();
  const contactName = String(request.body?.contactName || pending.name || '').trim();
  const phone = normalizePhone(request.body?.phone);
  if (businessName.length < 2) return response.status(400).json({ error: 'Enter a valid shop name.' });
  if (contactName.length < 2) return response.status(400).json({ error: 'Enter your full name.' });
  if (!phone) return response.status(400).json({ error: 'Enter a valid phone number, including the country code.' });
  try {
    const result = await queryWithRetry(
      `INSERT INTO sellers (business_name, contact_name, email, phone, google_id, auth_provider, email_verified_at)
       VALUES ($1,$2,$3,$4,$5,'google',NOW()) RETURNING id, status`,
      [businessName, contactName, pending.email, phone, pending.googleId]
    );
    clearCookie(response, googlePendingCookie);
    response.status(201).json({
      status: result.rows[0].status,
      emailVerified: true,
      message: 'Application submitted and your email is verified. We will let you know once your shop is approved.',
    });
  } catch (error) {
    if (error.code === '23505') return response.status(409).json({ error: 'A seller account with that email already exists. Sign in instead.' });
    console.error('Google seller register error:', error);
    response.status(500).json({ error: 'Could not submit your application.' });
  }
});

/* Answers the same way whether or not the email belongs to a seller, so
   this cannot be used to find out who sells here. Resends are throttled
   per account, and the button enforces the same wait so a real seller
   still gets feedback. */
app.post('/api/seller/otp/send', async (request, response) => {
  const email = String(request.body?.email || '').trim().toLowerCase();
  const generic = { ok: true, message: `If that email belongs to a seller account, a ${OTP_LENGTH}-digit code is on its way.`, resendAfter: OTP_RESEND_SECONDS };
  if (!isValidEmail(email)) return response.status(400).json({ error: 'Enter a valid email address.' });
  if (!smtpConfigured()) console.warn('A seller asked for a verification code but SMTP is not configured.');
  try {
    const found = await queryWithRetry('SELECT id, email_verified_at, otp_sent_at FROM sellers WHERE email = $1', [email]);
    const seller = found.rows[0];
    if (!seller || seller.email_verified_at) return response.json(generic);
    const sentAt = seller.otp_sent_at ? new Date(seller.otp_sent_at).getTime() : 0;
    if (Date.now() - sentAt < OTP_RESEND_SECONDS * 1000) return response.json(generic);

    const code = generateOtp();
    await queryWithRetry(
      `UPDATE sellers SET otp_hash = $2, otp_expires_at = NOW() + INTERVAL '${OTP_TTL_MINUTES} minutes', otp_attempts = 0, otp_sent_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [seller.id, hashOtp(code)]
    );
    // The code never goes in the response: with no SMTP configured it
    // reaches only the server console, where a developer can find it.
    await sendSellerOtpEmail(email, code, OTP_TTL_MINUTES);
    response.json(generic);
  } catch (error) {
    console.error('Seller OTP send error:', error);
    response.status(500).json({ error: 'Could not send a verification code. Please try again.' });
  }
});

app.post('/api/seller/otp/verify', async (request, response) => {
  const email = String(request.body?.email || '').trim().toLowerCase();
  const code = String(request.body?.code || '').replace(/[^0-9]/g, '');
  const wrong = 'That code is not right. Check it and try again.';
  if (!isValidEmail(email) || code.length !== OTP_LENGTH) return response.status(400).json({ error: wrong });
  try {
    const found = await queryWithRetry(
      'SELECT id, otp_hash, otp_attempts, email_verified_at, otp_expires_at > NOW() AS live FROM sellers WHERE email = $1',
      [email]
    );
    const seller = found.rows[0];
    // Same answer for an unknown email as for a wrong code, so a failed
    // guess says nothing about whether the account exists.
    if (!seller) return response.status(400).json({ error: wrong });
    if (seller.email_verified_at) return response.json({ verified: true, message: 'That email is already verified.' });
    if (!seller.otp_hash || !seller.live) return response.status(400).json({ error: 'That code has expired. Request a new one.' });
    if (seller.otp_attempts >= OTP_MAX_ATTEMPTS) return response.status(429).json({ error: 'Too many attempts. Request a new code.' });

    if (!otpMatches(code, seller.otp_hash)) {
      await queryWithRetry('UPDATE sellers SET otp_attempts = otp_attempts + 1 WHERE id = $1', [seller.id]);
      const left = OTP_MAX_ATTEMPTS - (seller.otp_attempts + 1);
      return response.status(400).json({ error: left > 0 ? `${wrong} ${left} attempt${left === 1 ? '' : 's'} left.` : 'Too many attempts. Request a new code.' });
    }

    await queryWithRetry(
      'UPDATE sellers SET email_verified_at = NOW(), otp_hash = NULL, otp_expires_at = NULL, otp_attempts = 0, updated_at = NOW() WHERE id = $1',
      [seller.id]
    );
    response.json({ verified: true, message: 'Email verified. Your application is with the store owner now.' });
  } catch (error) {
    console.error('Seller OTP verify error:', error);
    response.status(500).json({ error: 'Could not check that code. Please try again.' });
  }
});

app.post('/api/seller/register', async (request, response) => {
  const businessName = String(request.body?.businessName || '').trim();
  const contactName = String(request.body?.contactName || '').trim();
  const email = String(request.body?.email || '').trim().toLowerCase();
  const phone = normalizePhone(request.body?.phone);
  const password = String(request.body?.password || '');
  if (!businessName || !contactName || !email || !password) return response.status(400).json({ error: 'Shop name, contact name, email, and password are required.' });
  if (businessName.length < 2 || contactName.length < 2) return response.status(400).json({ error: 'Enter a valid shop name and contact name.' });
  if (!isValidEmail(email)) return response.status(400).json({ error: 'Enter a valid email address.' });
  if (!phone) return response.status(400).json({ error: 'Enter a valid phone number, including the country code.' });
  if (password.length < 6) return response.status(400).json({ error: 'Password must be at least 6 characters.' });
  try {
    const code = generateOtp();
    const result = await queryWithRetry(
      `INSERT INTO sellers (business_name, contact_name, email, phone, password_hash, otp_hash, otp_expires_at, otp_sent_at)
       VALUES ($1,$2,$3,$4,$5,$6, NOW() + INTERVAL '${OTP_TTL_MINUTES} minutes', NOW())
       RETURNING id, business_name, status`,
      [businessName, contactName, email, phone, hashPassword(password), hashOtp(code)]
    );
    // Sent on the way out so the first code is already in their inbox by
    // the time the verify step appears.
    const emailed = await sendSellerOtpEmail(email, code, OTP_TTL_MINUTES);
    response.status(201).json({
      status: result.rows[0].status,
      email,
      verificationRequired: true,
      codeSent: emailed,
      message: emailed
        ? `We sent a ${OTP_LENGTH}-digit code to ${email}. Enter it below to verify your email.`
        : 'Application submitted. Email delivery is not set up on this store, so ask the owner to verify you.',
    });
  } catch (error) {
    if (error.code === '23505') return response.status(409).json({ error: 'A seller account with that email already exists.' });
    console.error('Seller register error:', error);
    response.status(500).json({ error: 'Could not submit your application.' });
  }
});

app.post('/api/seller/login', async (request, response) => {
  const email = String(request.body?.email || '').trim().toLowerCase();
  const password = String(request.body?.password || '');
  if (!email || !password) return response.status(400).json({ error: 'Email and password are required.' });
  try {
    const result = await queryWithRetry('SELECT id, business_name, contact_name, email, phone, password_hash, status FROM sellers WHERE email = $1', [email]);
    const seller = result.rows[0];
    // Signed up with Google and never set a password: say so rather than
    // letting them guess at a password that does not exist.
    if (seller && !seller.password_hash) return response.status(409).json({ error: 'That account signs in with Google. Use the Continue with Google button.' });
    if (!seller || !verifyPassword(password, seller.password_hash)) return response.status(401).json({ error: 'Invalid email or password.' });
    if (seller.status === 'pending') return response.status(403).json({ error: 'Your application is still awaiting approval.' });
    if (seller.status === 'suspended') return response.status(403).json({ error: 'Your seller account has been suspended.' });
    setSellerSessionCookie(response, seller.id);
    response.json({ id: seller.id, businessName: seller.business_name, contactName: seller.contact_name, email: seller.email, phone: seller.phone });
  } catch (error) {
    console.error('Seller login error:', error);
    response.status(500).json({ error: 'Could not sign you in.' });
  }
});

app.post('/api/seller/logout', (_request, response) => {
  response.set('Set-Cookie', `${sellerSessionCookie}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  response.sendStatus(204);
});

app.get('/api/seller/me', async (request, response) => {
  const sellerId = currentSellerId(request);
  if (!sellerId) return response.status(401).json({ error: 'Not signed in.' });
  try {
    const result = await queryWithRetry(
      'SELECT id, business_name, contact_name, email, phone, status, auth_provider, email_verified_at FROM sellers WHERE id = $1',
      [sellerId]
    );
    if (!result.rowCount || result.rows[0].status !== 'active') return response.status(401).json({ error: 'Not signed in.' });
    const seller = result.rows[0];
    response.json({ ...seller, emailVerified: Boolean(seller.email_verified_at) });
  } catch (error) {
    console.error(error);
    response.status(500).json({ error: 'Could not load your account.' });
  }
});

app.get('/api/seller/products', async (request, response) => {
  const sellerId = currentSellerId(request);
  if (!sellerId) return response.sendStatus(401);
  try {
    const result = await queryWithRetry(
      `SELECT p.id, p.name, p.category_id, c.name AS category, p.brand_id, b.name AS brand, p.price, p.original_price AS "originalPrice", p.stock_quantity AS stock, p.badge, p.specifications AS spec, p.description,
        p.image_path AS image, p.image_path_2 AS image2, p.image_path_3 AS image3, p.status
       FROM products p JOIN categories c ON c.id = p.category_id JOIN brands b ON b.id = p.brand_id
       WHERE p.seller_id = $1 ORDER BY p.id DESC`,
      [sellerId]
    );
    response.json({ products: result.rows });
  } catch (error) {
    console.error(error);
    response.status(500).json({ error: 'Could not load your products.' });
  }
});

app.post('/api/seller/products', uploadProductImages, async (request, response) => {
  const sellerId = currentSellerId(request);
  if (!sellerId) return response.sendStatus(401);
  const body = request.body;
  const values = [body.name, Number(body.categoryId), Number(body.brandId), Number(body.price), body.originalPrice ? Number(body.originalPrice) : null, Number(body.stock || 0), body.badge || null, body.spec || null, body.description || null];
  if (!body.name || !values[1] || !values[2] || Number.isNaN(values[3])) return response.status(400).json({ error: 'Name, category, brand, and price are required.' });
  const status = values[5] === 0 ? 'out' : values[5] <= 5 ? 'low' : 'in';
  try {
    const files = request.files || {};
    const [image, image2, image3] = await Promise.all([
      imageUrl(files.image?.[0]),
      imageUrl(files.image2?.[0]),
      imageUrl(files.image3?.[0]),
    ]);
    const result = await pool.query(
      `INSERT INTO products (name, category_id, brand_id, price, original_price, stock_quantity, badge, specifications, description, image_path, image_path_2, image_path_3, status, seller_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [...values, image, image2, image3, status, sellerId]
    );
    invalidateCatalogCache();
    response.status(201).json(result.rows[0]);
  } catch (error) {
    response.status(error.code === '23503' ? 400 : 500).json({ error: error.code === '23503' ? 'Selected category or brand does not exist.' : 'Could not save product.' });
  }
});

app.put('/api/seller/products/:id', uploadProductImages, async (request, response) => {
  const sellerId = currentSellerId(request);
  if (!sellerId) return response.sendStatus(401);
  const body = request.body;
  const stock = Number(body.stock || 0);
  const values = [body.name, Number(body.categoryId), Number(body.brandId), Number(body.price), body.originalPrice ? Number(body.originalPrice) : null, stock, body.badge || null, body.spec || null, body.description || null];
  if (!body.name || !values[1] || !values[2] || Number.isNaN(values[3])) return response.status(400).json({ error: 'Name, category, brand, and price are required.' });
  const status = stock === 0 ? 'out' : stock <= 5 ? 'low' : 'in';
  try {
    const files = request.files || {};
    const imageEntries = await Promise.all([
      ['image_path', files.image?.[0]],
      ['image_path_2', files.image2?.[0]],
      ['image_path_3', files.image3?.[0]],
    ].map(async ([column, file]) => [column, file ? await imageUrl(file) : undefined]));
    const imageUpdates = imageEntries.filter(([, url]) => url !== undefined);

    const setClauses = ['name = $1', 'category_id = $2', 'brand_id = $3', 'price = $4', 'original_price = $5', 'stock_quantity = $6', 'badge = $7', 'specifications = $8', 'description = $9'];
    const queryValues = [...values];
    imageUpdates.forEach(([column, url]) => {
      queryValues.push(url);
      setClauses.push(`${column} = $${queryValues.length}`);
    });
    queryValues.push(status);
    setClauses.push(`status = $${queryValues.length}`);
    queryValues.push(request.params.id);
    const idParamIndex = queryValues.length;
    queryValues.push(sellerId);
    const sellerParamIndex = queryValues.length;

    const result = await pool.query(`UPDATE products SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = $${idParamIndex} AND seller_id = $${sellerParamIndex} RETURNING id`, queryValues);
    if (!result.rowCount) return response.status(404).json({ error: 'Product not found.' });
    invalidateCatalogCache();
    response.json(result.rows[0]);
  } catch (error) {
    response.status(error.code === '23503' ? 400 : 500).json({ error: error.code === '23503' ? 'Selected category or brand does not exist.' : 'Could not update product.' });
  }
});

app.delete('/api/seller/products/:id', async (request, response) => {
  const sellerId = currentSellerId(request);
  if (!sellerId) return response.sendStatus(401);
  try {
    const result = await pool.query('DELETE FROM products WHERE id = $1 AND seller_id = $2 RETURNING id', [request.params.id, sellerId]);
    if (!result.rowCount) return response.status(404).json({ error: 'Product not found.' });
    invalidateCatalogCache();
    response.sendStatus(204);
  } catch (error) {
    console.error(error);
    response.status(500).json({ error: 'Could not delete product.' });
  }
});

/* Admin-only: review and manage seller applications/accounts. */
app.get('/api/sellers', async (_request, response) => {
  try {
    const result = await queryWithRetry(
      `SELECT s.id, s.business_name, s.contact_name, s.email, s.phone, s.status, s.created_at,
         s.auth_provider, s.email_verified_at,
         (SELECT COUNT(*) FROM products p WHERE p.seller_id = s.id) AS product_count
       FROM sellers s ORDER BY (s.status = 'pending') DESC, s.created_at DESC`
    );
    response.json({ sellers: result.rows });
  } catch (error) {
    console.error(error);
    response.status(500).json({ error: 'Could not load sellers.' });
  }
});

app.put('/api/sellers/:id/status', async (request, response) => {
  const status = String(request.body?.status || '');
  if (!['pending', 'active', 'suspended'].includes(status)) return response.status(400).json({ error: 'Invalid status.' });
  try {
    const result = await queryWithRetry('UPDATE sellers SET status = $2, updated_at = NOW() WHERE id = $1 RETURNING id, status', [request.params.id, status]);
    if (!result.rowCount) return response.status(404).json({ error: 'Seller not found.' });
    invalidateCatalogCache();
    response.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    response.status(500).json({ error: 'Could not update seller status.' });
  }
});

/* The storefront, both dashboards and every page title read their
   branding from here, so store.config.js stays the single place to
   edit a store name, currency or phone number. Served as a script
   rather than JSON so it is available synchronously to everything
   that runs after it. */
app.get('/store-config.js', (_request, response) => {
  response.type('application/javascript');
  response.set('Cache-Control', 'no-cache');
  // `features` lets a page hide what this store cannot do - no dead
  // Google button on a store without OAuth credentials, no promise of an
  // email on a store with no SMTP.
  const payload = {
    ...storeConfig,
    features: { googleSignIn: googleConfigured(), emailDelivery: smtpConfigured() },
  };
  response.send(`window.STORE_CONFIG=${JSON.stringify(payload)};`);
});
app.get('/favicon.ico', (_request, response) => response.redirect(storeConfig.logo));
app.use('/admin', requireAdmin);
app.get('/seller/login.html', (_request, response) => response.sendFile(path.join(__dirname, 'seller', 'login.html')));
app.use('/seller', requireSellerPage);
app.use('/api', (request, response, next) => (request.path === '/catalog' || request.path === '/catalog/light' || request.path === '/taxonomy' || (request.method === 'POST' && request.path === '/orders') || request.path.startsWith('/account/') || request.path.startsWith('/seller/') || /^\/products\/\d+\/rate$/.test(request.path) || (request.method === 'GET' && /^\/products\/\d+$/.test(request.path))) ? next() : requireAdmin(request, response, next));
app.use('/uploads', express.static(uploadDirectory, { maxAge: '7d' }));
if (process.env.VERCEL) app.use('/uploads', express.static(path.join(__dirname, 'uploads'), { maxAge: '7d' }));
app.use('/images', express.static(path.join(__dirname, 'images'), { maxAge: '7d', immutable: true }));
app.use(express.static(__dirname, {
  setHeaders: (response, filePath) => {
    // Force JS/CSS to always revalidate instead of possibly being served
    // straight from a stale browser cache after a deploy - a fast 304 round
    // trip beats shipping a fix that silently doesn't show up for visitors.
    if (filePath.endsWith('.js') || filePath.endsWith('.css')) response.set('Cache-Control', 'no-cache');
  },
}));

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name VARCHAR(100) NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS brands (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name VARCHAR(100) NOT NULL UNIQUE,
      category_id INTEGER NOT NULL REFERENCES categories(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      category_id INTEGER NOT NULL REFERENCES categories(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      brand_id INTEGER NOT NULL REFERENCES brands(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      price NUMERIC(12, 2) NOT NULL CHECK (price >= 0),
      original_price NUMERIC(12, 2) CHECK (original_price >= 0),
      stock_quantity INTEGER NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
      badge VARCHAR(50),
      specifications VARCHAR(255),
      description TEXT,
      image_path TEXT,
      status VARCHAR(10) NOT NULL DEFAULT 'in' CHECK (status IN ('in', 'low', 'out')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE products ALTER COLUMN image_path TYPE TEXT;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS image_path_2 TEXT;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS image_path_3 TEXT;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS rating_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS rating_sum INTEGER NOT NULL DEFAULT 0;
    UPDATE products SET image_path = NULL WHERE image_path = '/uploads/undefined' OR image_path LIKE '%/undefined';
    UPDATE products SET image_path_2 = NULL WHERE image_path_2 LIKE '%/undefined';
    UPDATE products SET image_path_3 = NULL WHERE image_path_3 LIKE '%/undefined';
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name VARCHAR(150) NOT NULL,
      email VARCHAR(150) NOT NULL UNIQUE,
      phone VARCHAR(20),
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS cart JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS cart_updated_at TIMESTAMPTZ;
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      customer_name VARCHAR(150) NOT NULL,
      customer_phone VARCHAR(20) NOT NULL,
      customer_email VARCHAR(150),
      delivery_address TEXT NOT NULL,
      items JSONB NOT NULL,
      subtotal NUMERIC(12, 2) NOT NULL CHECK (subtotal >= 0),
      status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'cancelled')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_id INTEGER REFERENCES customers(id) ON UPDATE CASCADE ON DELETE SET NULL;
    CREATE TABLE IF NOT EXISTS sellers (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      business_name VARCHAR(150) NOT NULL,
      contact_name VARCHAR(150) NOT NULL,
      email VARCHAR(150) NOT NULL UNIQUE,
      phone VARCHAR(20),
      -- Null for an account that signs in with Google and has no password.
      password_hash TEXT,
      google_id VARCHAR(64),
      auth_provider VARCHAR(20) NOT NULL DEFAULT 'password',
      email_verified_at TIMESTAMPTZ,
      -- One pending verification code per seller: the hash, when it stops
      -- being valid, how many guesses have been made, and when it went out
      -- (which is what throttles resends).
      otp_hash TEXT,
      otp_expires_at TIMESTAMPTZ,
      otp_attempts SMALLINT NOT NULL DEFAULT 0,
      otp_sent_at TIMESTAMPTZ,
      status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- Added for Google sign-in and email verification; existing stores pick
    -- these up on the next start without losing any seller data.
    ALTER TABLE sellers ADD COLUMN IF NOT EXISTS google_id VARCHAR(64);
    ALTER TABLE sellers ADD COLUMN IF NOT EXISTS auth_provider VARCHAR(20) NOT NULL DEFAULT 'password';
    ALTER TABLE sellers ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
    ALTER TABLE sellers ADD COLUMN IF NOT EXISTS otp_hash TEXT;
    ALTER TABLE sellers ADD COLUMN IF NOT EXISTS otp_expires_at TIMESTAMPTZ;
    ALTER TABLE sellers ADD COLUMN IF NOT EXISTS otp_attempts SMALLINT NOT NULL DEFAULT 0;
    ALTER TABLE sellers ADD COLUMN IF NOT EXISTS otp_sent_at TIMESTAMPTZ;
    ALTER TABLE sellers ALTER COLUMN password_hash DROP NOT NULL;
    ALTER TABLE sellers ALTER COLUMN phone DROP NOT NULL;
    -- Postgres allows many NULLs under a unique index, so this constrains
    -- only the rows that actually have a Google account linked.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sellers_google_id ON sellers(google_id);
    ALTER TABLE products ADD COLUMN IF NOT EXISTS seller_id INTEGER REFERENCES sellers(id) ON UPDATE CASCADE ON DELETE SET NULL;

    -- Postgres does not auto-index foreign key columns (only primary keys and
    -- UNIQUE constraints get one for free) - these are every join/filter column
    -- hit on the hot paths: storefront catalog, seller dashboards, order history.
    -- Without them, each of those queries is a sequential scan that gets slower
    -- as products/orders grow and gets worse under concurrent traffic.
    CREATE INDEX IF NOT EXISTS idx_products_seller_id ON products(seller_id);
    CREATE INDEX IF NOT EXISTS idx_products_category_id ON products(category_id);
    CREATE INDEX IF NOT EXISTS idx_products_brand_id ON products(brand_id);
    CREATE INDEX IF NOT EXISTS idx_brands_category_id ON brands(category_id);
    CREATE INDEX IF NOT EXISTS idx_sellers_status ON sellers(status);
    CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders(customer_id);
    CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);
  `);
}

async function initializeDatabaseWithRetry() {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await initializeDatabase();
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 1) await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw lastError;
}

const databaseReady = initializeDatabaseWithRetry();
app.use('/api', async (_request, _response, next) => {
  try {
    await databaseReady;
    next();
  } catch (error) {
    next(error);
  }
});

/* Short in-memory cache for the two read-heavy public endpoints that every
   storefront visitor and every seller-dashboard boot hits: the light catalog
   and the taxonomy dropdown data. A burst of concurrent visitors previously
   meant a burst of concurrent identical DB queries; now only the first one
   past the TTL pays for a DB round trip and everyone else in that window
   gets served from memory. Invalidated immediately on any write that could
   change the response (product/category/brand/seller-status changes) so
   edits still show up right away - the TTL is just a ceiling on staleness
   for the read traffic in between. */
const catalogCache = { light: null, lightAt: 0, taxonomy: null, taxonomyAt: 0 };
const CATALOG_CACHE_TTL_MS = 20000;

function invalidateCatalogCache() {
  catalogCache.light = null;
  catalogCache.taxonomy = null;
}

async function queryWithRetry(text, values = [], attempts = 2) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await pool.query(text, values);
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw lastError;
}

app.get('/api/catalog', async (_request, response) => {
  try {
    const [categories, brands, products] = await Promise.all([
      queryWithRetry('SELECT id, name FROM categories ORDER BY name'),
      queryWithRetry(`SELECT b.id, b.name, b.category_id, c.name AS category_name FROM brands b JOIN categories c ON c.id = b.category_id ORDER BY b.name`),
      queryWithRetry(`SELECT p.id, p.name, p.category_id, c.name AS category, p.brand_id, b.name AS brand, p.price, p.original_price AS "originalPrice", p.stock_quantity AS stock, p.badge, p.specifications AS spec, p.description,
        CASE WHEN p.image_path LIKE '%/undefined' THEN NULL ELSE p.image_path END AS image,
        CASE WHEN p.image_path_2 LIKE '%/undefined' THEN NULL ELSE p.image_path_2 END AS image2,
        CASE WHEN p.image_path_3 LIKE '%/undefined' THEN NULL ELSE p.image_path_3 END AS image3,
        p.rating_count AS reviews,
        CASE WHEN p.rating_count > 0 THEN ROUND(p.rating_sum::numeric / p.rating_count, 1) ELSE 0 END AS rating,
        p.status, p.seller_id, s.business_name AS seller_name
        FROM products p JOIN categories c ON c.id = p.category_id JOIN brands b ON b.id = p.brand_id LEFT JOIN sellers s ON s.id = p.seller_id ORDER BY p.id DESC`),
    ]);
    response.json({ categories: categories.rows, brands: brands.rows, products: products.rows });
  } catch (error) {
    console.error(error);
    response.status(500).json({ error: 'Could not load catalog data.' });
  }
});

/* Product images under /images/products/ have a matching pre-generated
   webp thumbnail under /images/products/thumbs/ (see
   scripts/generate-thumbnails.js) - swap to that smaller file for the
   grid view, which never displays images larger than a card thumbnail. */
function thumbnailUrl(imagePath) {
  if (typeof imagePath !== 'string') return imagePath;
  const match = imagePath.match(/^\/images\/products\/([^/]+)\.[^./]+$/);
  if (!match) return imagePath;
  return `/images/products/thumbs/${match[1]}.webp`;
}

/* Admin-only (falls through to the default requireAdmin gate, same as
   /api/products etc.): lets the admin see every customer's phone number
   and current cart, so someone who added items and left can be followed
   up with directly rather than being lost entirely. */
app.get('/api/customers', async (_request, response) => {
  try {
    const result = await queryWithRetry(
      `SELECT id, name, email, phone, cart, cart_updated_at, created_at FROM customers
       ORDER BY jsonb_array_length(cart) > 0 DESC, cart_updated_at DESC NULLS LAST, created_at DESC`
    );
    response.json({ customers: result.rows });
  } catch (error) {
    console.error(error);
    response.status(500).json({ error: 'Could not load customers.' });
  }
});

/* Admin-only: every order placed, newest first, so admin can actually see
   what's been bought (the catalog/checkout side has worked all along -
   nothing surfaced it in the dashboard). */
app.get('/api/orders', async (_request, response) => {
  try {
    const result = await queryWithRetry(
      `SELECT id, customer_id, customer_name, customer_phone, customer_email, delivery_address, items, subtotal, status, created_at
       FROM orders ORDER BY created_at DESC LIMIT 300`
    );
    response.json({ orders: result.rows });
  } catch (error) {
    console.error(error);
    response.status(500).json({ error: 'Could not load orders.' });
  }
});

/* Categories + brands only - for the seller dashboard's product form
   dropdowns, which don't need the full product catalog (images and
   all) that /api/catalog/light carries just to populate two selects. */
app.get('/api/taxonomy', async (_request, response) => {
  if (catalogCache.taxonomy && Date.now() - catalogCache.taxonomyAt < CATALOG_CACHE_TTL_MS) {
    return response.json(catalogCache.taxonomy);
  }
  try {
    const [categories, brands] = await Promise.all([
      queryWithRetry('SELECT id, name FROM categories ORDER BY name'),
      queryWithRetry(`SELECT b.id, b.name, b.category_id, c.name AS category_name FROM brands b JOIN categories c ON c.id = b.category_id ORDER BY b.name`),
    ]);
    const payload = { categories: categories.rows, brands: brands.rows };
    catalogCache.taxonomy = payload;
    catalogCache.taxonomyAt = Date.now();
    response.json(payload);
  } catch (error) {
    console.error(error);
    response.status(500).json({ error: 'Could not load categories and brands.' });
  }
});

/* Storefront list view (shop grid, cart, checkout summary): drops description
   and the 2nd/3rd product images, which are only ever shown on the single
   product page, so the grid isn't downloading every product's full photo set
   just to render a thumbnail. */
app.get('/api/catalog/light', async (_request, response) => {
  if (catalogCache.light && Date.now() - catalogCache.lightAt < CATALOG_CACHE_TTL_MS) {
    return response.json(catalogCache.light);
  }
  try {
    const [categories, brands, products] = await Promise.all([
      queryWithRetry('SELECT id, name FROM categories ORDER BY name'),
      queryWithRetry(`SELECT b.id, b.name, b.category_id, c.name AS category_name FROM brands b JOIN categories c ON c.id = b.category_id ORDER BY b.name`),
      queryWithRetry(`SELECT p.id, p.name, p.category_id, c.name AS category, p.brand_id, b.name AS brand, p.price, p.original_price AS "originalPrice", p.stock_quantity AS stock, p.badge, p.specifications AS spec,
        CASE WHEN p.image_path LIKE '%/undefined' THEN NULL ELSE p.image_path END AS image,
        p.rating_count AS reviews,
        CASE WHEN p.rating_count > 0 THEN ROUND(p.rating_sum::numeric / p.rating_count, 1) ELSE 0 END AS rating,
        p.status FROM products p JOIN categories c ON c.id = p.category_id JOIN brands b ON b.id = p.brand_id
        LEFT JOIN sellers s ON s.id = p.seller_id WHERE p.seller_id IS NULL OR s.status = 'active' ORDER BY p.id DESC`),
    ]);
    products.rows.forEach(product => { product.image = thumbnailUrl(product.image); });
    const payload = { categories: categories.rows, brands: brands.rows, products: products.rows };
    catalogCache.light = payload;
    catalogCache.lightAt = Date.now();
    response.json(payload);
  } catch (error) {
    console.error(error);
    response.status(500).json({ error: 'Could not load catalog data.' });
  }
});

/* Single product (product detail page): avoids pulling every other
   product's data and images just to show one item. */
app.get('/api/products/:id', async (request, response) => {
  try {
    const result = await queryWithRetry(`SELECT p.id, p.name, p.category_id, c.name AS category, p.brand_id, b.name AS brand, p.price, p.original_price AS "originalPrice", p.stock_quantity AS stock, p.badge, p.specifications AS spec, p.description,
      CASE WHEN p.image_path LIKE '%/undefined' THEN NULL ELSE p.image_path END AS image,
      CASE WHEN p.image_path_2 LIKE '%/undefined' THEN NULL ELSE p.image_path_2 END AS image2,
      CASE WHEN p.image_path_3 LIKE '%/undefined' THEN NULL ELSE p.image_path_3 END AS image3,
      p.rating_count AS reviews,
      CASE WHEN p.rating_count > 0 THEN ROUND(p.rating_sum::numeric / p.rating_count, 1) ELSE 0 END AS rating,
      p.status FROM products p JOIN categories c ON c.id = p.category_id JOIN brands b ON b.id = p.brand_id
      LEFT JOIN sellers s ON s.id = p.seller_id WHERE p.id = $1 AND (p.seller_id IS NULL OR s.status = 'active')`, [request.params.id]);
    if (!result.rowCount) return response.status(404).json({ error: 'Product not found.' });
    response.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    response.status(500).json({ error: 'Could not load product.' });
  }
});

app.post('/api/products/:id/rate', async (request, response) => {
  const rating = Number(request.body?.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return response.status(400).json({ error: 'Rating must be a whole number from 1 to 5.' });
  try {
    const result = await queryWithRetry(
      `UPDATE products SET rating_count = rating_count + 1, rating_sum = rating_sum + $2, updated_at = NOW() WHERE id = $1 RETURNING rating_count, rating_sum`,
      [request.params.id, rating]
    );
    if (!result.rowCount) return response.status(404).json({ error: 'Product not found.' });
    const { rating_count: reviews, rating_sum: sum } = result.rows[0];
    response.json({ reviews, rating: Math.round((sum / reviews) * 10) / 10 });
  } catch (error) {
    console.error('Rating error:', error);
    response.status(500).json({ error: 'Could not save your rating.' });
  }
});

/* Phone numbers are free-form worldwide, so this only strips the
   formatting a person might type and checks the length is plausible -
   it deliberately does not assume a country. */
function normalizePhone(raw) {
  const trimmed = String(raw || '').trim();
  const digits = trimmed.replace(/[^0-9]/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return trimmed.startsWith('+') ? `+${digits}` : digits;
}

/* Client-side type="email"/pattern attributes only guard the form - anyone
   calling the API directly bypasses them, so every account-creating route
   re-checks format here too. */
function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ''));
}

/* Re-checks price AND current stock against the database at checkout time -
   a customer's local cart can go stale (another buyer took the last unit,
   admin marked something out of stock) since nothing re-validates it
   between adding to cart and paying. */
/* Thrown for the cases a shopper can actually act on, so the route can
   pass the message through instead of hiding every failure behind a
   generic one. Anything untagged is treated as a server fault. */
function cartError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

async function priceAndCheckStock(items) {
  const ids = items.map(item => Number(item.productId)).filter(Boolean);
  const priced = await queryWithRetry('SELECT id, name, price, stock_quantity, status FROM products WHERE id = ANY($1)', [ids]);
  const productMap = new Map(priced.rows.map(row => [row.id, row]));
  let subtotal = 0;
  const orderItems = items.map(item => {
    const id = Number(item.productId);
    const qty = Math.max(1, Number(item.qty) || 1);
    const product = productMap.get(id);
    if (!product) throw cartError('One or more cart items are no longer available.');
    if (product.status === 'out' || product.stock_quantity <= 0) throw cartError(`${product.name} just sold out - remove it from your cart to continue.`);
    if (qty > product.stock_quantity) throw cartError(`Only ${product.stock_quantity} of ${product.name} left in stock - adjust the quantity in your cart.`);
    const price = Number(product.price);
    subtotal += price * qty;
    return { productId: id, qty, price };
  });
  return { orderItems, subtotal };
}

/* Called when an order is placed, and again (through incrementStock)
   if that order is later cancelled, so the numbers in the dashboard
   always reflect what is actually committed to buyers. */
async function decrementStock(orderItems) {
  // Each update targets a different product row, so there's no contention
  // between them - running them concurrently instead of one-at-a-time cuts
  // an N-round-trip serial chain down to a single round trip, which matters
  // most on multi-item orders during a burst of concurrent checkouts.
  await Promise.all((orderItems || []).map(item => queryWithRetry(
    `UPDATE products SET
       stock_quantity = GREATEST(stock_quantity - $2, 0),
       status = CASE WHEN stock_quantity - $2 <= 0 THEN 'out' WHEN stock_quantity - $2 <= 5 THEN 'low' ELSE 'in' END,
       updated_at = NOW()
     WHERE id = $1`,
    [item.productId, item.qty]
  )));
}

/* Mirror image of decrementStock, for when an order is cancelled: the
   units it was holding go back on sale and the in/low/out label is
   recomputed from the restored quantity. */
async function incrementStock(orderItems) {
  await Promise.all((orderItems || []).map(item => queryWithRetry(
    `UPDATE products SET
       stock_quantity = stock_quantity + $2,
       status = CASE WHEN stock_quantity + $2 <= 0 THEN 'out' WHEN stock_quantity + $2 <= 5 THEN 'low' ELSE 'in' END,
       updated_at = NOW()
     WHERE id = $1`,
    [item.productId, item.qty]
  )));
}

/* ============================================================
   ORDERS

   There is no payment gateway wired in. Checkout records the order
   and the shop owner takes payment their own way (on delivery, bank
   transfer, a gateway you add yourself), then marks it paid from the
   admin dashboard. To plug in a provider, charge the customer here
   between priceAndCheckStock() and the INSERT, and create the order
   as 'paid' when the charge succeeds.
   ============================================================ */
app.post('/api/orders', async (request, response) => {
  const body = request.body || {};
  const customer = body.customer || {};
  const items = Array.isArray(body.items) ? body.items : [];
  const name = String(customer.name || '').trim();
  const address = String(customer.address || '').trim();
  const email = customer.email ? String(customer.email).trim() : null;
  const phone = normalizePhone(customer.phone);
  if (!name || !address) return response.status(400).json({ error: 'Name and delivery address are required.' });
  if (!phone) return response.status(400).json({ error: 'Enter a valid phone number, including the country code.' });
  if (!items.length) return response.status(400).json({ error: 'Your cart is empty.' });

  try {
    // Never trust the amounts the browser sends: both price and stock
    // are re-read from the database here.
    const { orderItems, subtotal } = await priceAndCheckStock(items);

    const orderResult = await queryWithRetry(
      `INSERT INTO orders (customer_id, customer_name, customer_phone, customer_email, delivery_address, items, subtotal)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at`,
      [currentCustomerId(request), name, phone, email, address, JSON.stringify(orderItems), subtotal]
    );
    const order = orderResult.rows[0];

    // The units are committed to this buyer the moment the order
    // exists, so they come off sale now and go back if it is cancelled.
    await decrementStock(orderItems);
    invalidateCatalogCache();
    await saveCustomerCart(currentCustomerId(request), []);

    response.status(201).json({ orderId: order.id, amount: subtotal, status: 'pending' });
  } catch (error) {
    console.error('Order error:', error);
    // A stock or pricing problem is the shopper's to fix; anything else
    // is ours, and shouldn't surface as a message about their cart.
    if (error.status === 400) return response.status(400).json({ error: error.message });
    response.status(500).json({ error: 'Could not place the order. Please try again.' });
  }
});

/* Admin-only: the one place an order changes state, and the only thing
   that moves stock after checkout. The status it is moving FROM is read
   from the database rather than taken from the caller, and the update is
   guarded on it, so two dashboards racing each other can't apply the
   same stock change twice. */
app.put('/api/orders/:id/status', async (request, response) => {
  const orderId = Number(request.params.id);
  const status = String(request.body?.status || '').trim();
  if (!Number.isInteger(orderId) || orderId <= 0) return response.status(400).json({ error: 'Invalid order id.' });
  if (!['pending', 'paid', 'cancelled'].includes(status)) return response.status(400).json({ error: 'Status must be pending, paid or cancelled.' });
  try {
    const existing = await queryWithRetry('SELECT status FROM orders WHERE id = $1', [orderId]);
    if (!existing.rowCount) return response.status(404).json({ error: 'Order not found.' });
    const previousStatus = existing.rows[0].status;
    if (previousStatus === status) return response.json({ ok: true, status, unchanged: true });

    const updated = await queryWithRetry(
      `UPDATE orders SET status = $2, updated_at = NOW() WHERE id = $1 AND status = $3 RETURNING items`,
      [orderId, status, previousStatus]
    );
    // Someone else changed it in between; their stock adjustment stands.
    if (!updated.rowCount) return response.status(409).json({ error: 'That order was just updated somewhere else. Reload and try again.' });

    const { items } = updated.rows[0];
    // Stock left the shelf when the order was placed, so it only moves
    // again when the order is cancelled (back on sale) or un-cancelled.
    if (status === 'cancelled') await incrementStock(items);
    else if (previousStatus === 'cancelled') await decrementStock(items);
    invalidateCatalogCache();
    response.json({ ok: true, status });
  } catch (error) {
    console.error(error);
    response.status(500).json({ error: 'Could not update the order.' });
  }
});

app.use((error, _request, response, _next) => {
  console.error('Unhandled server error:', error);
  response.status(500).json({ error: 'Catalog service temporarily unavailable.' });
});

app.post('/api/categories', async (request, response) => {
  const name = String(request.body.name || '').trim();
  if (!name) return response.status(400).json({ error: 'Category name is required.' });
  try {
    const result = await pool.query('INSERT INTO categories (name) VALUES ($1) RETURNING id, name', [name]);
    invalidateCatalogCache();
    response.status(201).json(result.rows[0]);
  } catch (error) {
    response.status(error.code === '23505' ? 409 : 500).json({ error: error.code === '23505' ? 'Category already exists.' : 'Could not save category.' });
  }
});

app.put('/api/categories/:id', async (request, response) => {
  const name = String(request.body.name || '').trim();
  if (!name) return response.status(400).json({ error: 'Category name is required.' });
  try {
    const result = await pool.query('UPDATE categories SET name = $1, updated_at = NOW() WHERE id = $2 RETURNING id, name', [name, request.params.id]);
    if (!result.rowCount) return response.status(404).json({ error: 'Category not found.' });
    invalidateCatalogCache();
    response.json(result.rows[0]);
  } catch (error) {
    response.status(error.code === '23505' ? 409 : 500).json({ error: error.code === '23505' ? 'Category already exists.' : 'Could not update category.' });
  }
});

app.delete('/api/categories/:id', async (request, response) => {
  try {
    const result = await pool.query('DELETE FROM categories WHERE id = $1 RETURNING id', [request.params.id]);
    if (!result.rowCount) return response.status(404).json({ error: 'Category not found.' });
    invalidateCatalogCache();
    response.sendStatus(204);
  } catch (error) {
    response.status(error.code === '23503' ? 409 : 500).json({ error: error.code === '23503' ? 'This category is used by a brand or product.' : 'Could not delete category.' });
  }
});

app.post('/api/brands', async (request, response) => {
  const name = String(request.body.name || '').trim();
  const categoryId = Number(request.body.categoryId);
  if (!name || !categoryId) return response.status(400).json({ error: 'Brand name and category are required.' });
  try {
    const result = await pool.query('INSERT INTO brands (name, category_id) VALUES ($1, $2) RETURNING id, name, category_id', [name, categoryId]);
    invalidateCatalogCache();
    response.status(201).json(result.rows[0]);
  } catch (error) {
    response.status(error.code === '23505' ? 409 : error.code === '23503' ? 400 : 500).json({ error: error.code === '23505' ? 'Brand already exists.' : error.code === '23503' ? 'Selected category does not exist.' : 'Could not save brand.' });
  }
});

app.put('/api/brands/:id', async (request, response) => {
  const name = String(request.body.name || '').trim();
  const categoryId = Number(request.body.categoryId);
  if (!name || !categoryId) return response.status(400).json({ error: 'Brand name and category are required.' });
  try {
    const result = await pool.query('UPDATE brands SET name = $1, category_id = $2, updated_at = NOW() WHERE id = $3 RETURNING id, name, category_id', [name, categoryId, request.params.id]);
    if (!result.rowCount) return response.status(404).json({ error: 'Brand not found.' });
    invalidateCatalogCache();
    response.json(result.rows[0]);
  } catch (error) {
    response.status(error.code === '23505' ? 409 : error.code === '23503' ? 400 : 500).json({ error: error.code === '23505' ? 'Brand already exists.' : error.code === '23503' ? 'Selected category does not exist.' : 'Could not update brand.' });
  }
});

app.delete('/api/brands/:id', async (request, response) => {
  try {
    const result = await pool.query('DELETE FROM brands WHERE id = $1 RETURNING id', [request.params.id]);
    if (!result.rowCount) return response.status(404).json({ error: 'Brand not found.' });
    invalidateCatalogCache();
    response.sendStatus(204);
  } catch (error) {
    response.status(error.code === '23503' ? 409 : 500).json({ error: error.code === '23503' ? 'This brand is used by a product.' : 'Could not delete brand.' });
  }
});

async function imageUrl(file) {
  if (!file) return null;
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    const blob = await put(`products/${Date.now()}-${file.originalname}`, file.buffer || fs.readFileSync(file.path), {
      access: 'public',
      addRandomSuffix: true,
      contentType: file.mimetype,
    });
    return blob.url;
  }
  if (file.buffer) {
    /* No Blob token configured and no persistent disk to write to (Vercel's
       filesystem is read-only except /tmp) - the only place left to keep the
       image is the database itself. A raw phone photo there is several MB of
       base64 text on every catalog/product-list response, so resize and
       recompress before it ever gets that far. */
    const optimized = await sharp(file.buffer).resize({ width: 1200, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    return `data:image/webp;base64,${optimized.toString('base64')}`;
  }
  return `/uploads/${file.filename}`;
}

/* Replacing a product's image (PUT with a new file) or deleting the product
   outright previously just overwrote or dropped the DB column - the actual
   file (on local disk, or in Blob storage) was never removed, so every edit
   or deletion left an orphan behind forever. This is the cleanup for both
   call sites. Best-effort: logs and moves on rather than failing the
   request, since a stray file is a much smaller problem than a product
   update failing because its old photo couldn't be removed. */
async function deleteStoredImage(urlPath) {
  if (!urlPath || typeof urlPath !== 'string') return;
  try {
    if (urlPath.startsWith('data:')) return; // only ever lived in this DB column
    if (/^https:\/\/[^/]+\.public\.blob\.vercel-storage\.com\//.test(urlPath)) {
      if (process.env.BLOB_READ_WRITE_TOKEN) await del(urlPath);
      return;
    }
    if (urlPath.startsWith('/uploads/')) {
      await fs.promises.unlink(path.join(uploadDirectory, path.basename(urlPath)));
      return;
    }
    if (urlPath.startsWith('/images/products/')) {
      await fs.promises.unlink(path.join(__dirname, urlPath));
      const thumb = thumbnailUrl(urlPath);
      if (thumb !== urlPath) await fs.promises.unlink(path.join(__dirname, thumb)).catch(() => {});
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not delete old product image:', urlPath, error.message);
  }
}

app.post('/api/products', uploadProductImages, async (request, response) => {
  const body = request.body;
  const values = [body.name, Number(body.categoryId), Number(body.brandId), Number(body.price), body.originalPrice ? Number(body.originalPrice) : null, Number(body.stock || 0), body.badge || null, body.spec || null, body.description || null];
  if (!body.name || !values[1] || !values[2] || Number.isNaN(values[3])) return response.status(400).json({ error: 'Name, category, brand, and price are required.' });
  const status = values[5] === 0 ? 'out' : values[5] <= 5 ? 'low' : 'in';
  try {
    const files = request.files || {};
    const [image, image2, image3] = await Promise.all([
      imageUrl(files.image?.[0]),
      imageUrl(files.image2?.[0]),
      imageUrl(files.image3?.[0]),
    ]);
    const result = await pool.query(`INSERT INTO products (name, category_id, brand_id, price, original_price, stock_quantity, badge, specifications, description, image_path, image_path_2, image_path_3, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`, [...values, image, image2, image3, status]);
    invalidateCatalogCache();
    response.status(201).json(result.rows[0]);
  } catch (error) {
    response.status(error.code === '23503' ? 400 : 500).json({ error: error.code === '23503' ? 'Selected category or brand does not exist.' : 'Could not save product.' });
  }
});

app.put('/api/products/:id', uploadProductImages, async (request, response) => {
  const body = request.body;
  const stock = Number(body.stock || 0);
  const values = [body.name, Number(body.categoryId), Number(body.brandId), Number(body.price), body.originalPrice ? Number(body.originalPrice) : null, stock, body.badge || null, body.spec || null, body.description || null];
  if (!body.name || !values[1] || !values[2] || Number.isNaN(values[3])) return response.status(400).json({ error: 'Name, category, brand, and price are required.' });
  const status = stock === 0 ? 'out' : stock <= 5 ? 'low' : 'in';
  try {
    const files = request.files || {};
    const imageEntries = await Promise.all([
      ['image_path', files.image?.[0]],
      ['image_path_2', files.image2?.[0]],
      ['image_path_3', files.image3?.[0]],
    ].map(async ([column, file]) => [column, file ? await imageUrl(file) : undefined]));
    const imageUpdates = imageEntries.filter(([, url]) => url !== undefined);

    // Fetch whatever this product's current image columns point to, for any
    // column a new upload is about to replace - that old file becomes an
    // orphan the moment the UPDATE below commits, so it has to be deleted
    // afterward (not before, in case the UPDATE fails and the old file is
    // still the live one).
    let replacedImages = [];
    if (imageUpdates.length) {
      const existing = await pool.query('SELECT image_path, image_path_2, image_path_3 FROM products WHERE id = $1', [request.params.id]);
      if (existing.rowCount) {
        const oldByColumn = { image_path: existing.rows[0].image_path, image_path_2: existing.rows[0].image_path_2, image_path_3: existing.rows[0].image_path_3 };
        replacedImages = imageUpdates.map(([column]) => oldByColumn[column]).filter(Boolean);
      }
    }

    const setClauses = ['name = $1', 'category_id = $2', 'brand_id = $3', 'price = $4', 'original_price = $5', 'stock_quantity = $6', 'badge = $7', 'specifications = $8', 'description = $9'];
    const queryValues = [...values];
    imageUpdates.forEach(([column, url]) => {
      queryValues.push(url);
      setClauses.push(`${column} = $${queryValues.length}`);
    });
    queryValues.push(status);
    setClauses.push(`status = $${queryValues.length}`);
    queryValues.push(request.params.id);

    const result = await pool.query(`UPDATE products SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = $${queryValues.length} RETURNING id`, queryValues);
    if (!result.rowCount) return response.status(404).json({ error: 'Product not found.' });
    invalidateCatalogCache();
    response.json(result.rows[0]);
    // Fire-and-forget: the response is already sent, and deleteStoredImage
    // never rejects (it catches and logs internally), but .catch is kept
    // here too so nothing could ever reach back into this response.
    Promise.all(replacedImages.map(deleteStoredImage)).catch(() => {});
  } catch (error) {
    response.status(error.code === '23503' ? 400 : 500).json({ error: error.code === '23503' ? 'Selected category or brand does not exist.' : 'Could not update product.' });
  }
});

app.delete('/api/products/:id', async (request, response) => {
  try {
    const result = await pool.query('DELETE FROM products WHERE id = $1 RETURNING id, image_path, image_path_2, image_path_3', [request.params.id]);
    if (!result.rowCount) return response.status(404).json({ error: 'Product not found.' });
    invalidateCatalogCache();
    response.sendStatus(204);
    const { image_path, image_path_2, image_path_3 } = result.rows[0];
    Promise.all([image_path, image_path_2, image_path_3].map(deleteStoredImage)).catch(() => {});
  } catch (error) {
    console.error(error);
    response.status(500).json({ error: 'Could not delete product.' });
  }
});

app.get(['/', '/admin', '/admin/', '/index.html', '/home.html'], (request, response) => {
  const page = request.path.startsWith('/admin') ? path.join(__dirname, 'admin', 'index.html') : path.join(__dirname, 'index.html');
  response.sendFile(page);
});

if (require.main === module) {
  databaseReady
    .then(() => app.listen(port, () => console.log(`${storeConfig.name} running at http://localhost:${port}/`)))
    .catch(error => { console.error('Database connection failed:', error.message); process.exit(1); });
}

module.exports = app;
