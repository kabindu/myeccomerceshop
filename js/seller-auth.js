/* ============================================================
   SELLER SIGN-IN PAGE — password sign-in, Google sign-in, the
   finish-your-Google-signup form, and email code verification.

   Lives in /js rather than /seller/js because everything under
   /seller is behind the seller session check; this page has to work
   for someone who is not signed in yet.
   ============================================================ */
const features = (window.STORE_CONFIG && window.STORE_CONFIG.features) || {};
const params = new URLSearchParams(window.location.search);

/* What the Google callback redirects back with when it cannot finish.
   Anything not listed here is ignored rather than echoed to the page. */
const NOTICES = {
  'google-state': { type: 'error', text: 'That sign-in link expired or did not start here. Please try again.' },
  'google-cancelled': { type: 'info', text: 'Google sign-in was cancelled.' },
  'google-failed': { type: 'error', text: 'Google sign-in did not complete. Please try again.' },
  'google-unavailable': { type: 'error', text: 'Google sign-in is not set up on this store.' },
  'google-unverified': { type: 'error', text: 'That Google account has an unverified email address.' },
  'awaiting-approval': { type: 'info', text: 'Your email is verified. Your shop is still waiting for the store owner to approve it.' },
  suspended: { type: 'error', text: 'That seller account has been suspended. Contact the store owner.' },
};

const show = (id, visible) => { document.getElementById(id).hidden = !visible; };
const setText = (id, text) => { document.getElementById(id).textContent = text || ''; };

function showNotice(notice) {
  if (!notice) return;
  const el = document.getElementById('authNotice');
  el.textContent = notice.text;
  el.className = `acct-notice ${notice.type}`;
  el.hidden = false;
}

function setTab(tab) {
  document.querySelectorAll('.acct-tab').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
  show('loginForm', tab === 'login');
  show('registerForm', tab === 'register');
  show('registerSuccess', false);
}

/* ---------- email verification step ---------- */
let verifyEmail = '';
let resendTimer = null;

function openVerifyStep(email, message) {
  verifyEmail = email;
  setText('verifyEmailLabel', email);
  setText('verifyMessage', message || '');
  show('acctForms', false);
  show('verifyStep', true);
  document.getElementById('otpInput').value = '';
  document.getElementById('otpInput').focus();
  startResendCooldown();
}

/* The server throttles resends per account but answers identically for
   an address it does not know, so the countdown lives here - otherwise
   the response itself would reveal whether the account exists. */
function startResendCooldown(seconds = 60) {
  const button = document.getElementById('otpResendBtn');
  let left = seconds;
  clearInterval(resendTimer);
  button.disabled = true;
  const tick = () => {
    button.textContent = left > 0 ? `Resend code (${left}s)` : 'Resend code';
    if (left <= 0) { clearInterval(resendTimer); button.disabled = false; }
    left -= 1;
  };
  tick();
  resendTimer = setInterval(tick, 1000);
}

async function sendCode() {
  setText('otpError', '');
  try {
    const data = await request('/api/seller/otp/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: verifyEmail }),
    });
    setText('verifyMessage', data.message);
    startResendCooldown(data.resendAfter || 60);
  } catch (error) {
    setText('otpError', error.message);
  }
}

async function verifyCode(event) {
  event.preventDefault();
  setText('otpError', '');
  const code = document.getElementById('otpInput').value.replace(/[^0-9]/g, '');
  if (code.length !== 6) return setText('otpError', 'Enter the 6-digit code from your email.');
  const button = document.getElementById('otpSubmitBtn');
  button.disabled = true;
  try {
    await request('/api/seller/otp/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: verifyEmail, code }),
    });
    clearInterval(resendTimer);
    show('verifyStep', false);
    show('verifiedStep', true);
  } catch (error) {
    setText('otpError', error.message);
  } finally {
    button.disabled = false;
  }
}

/* ---------- finishing a Google signup ---------- */
async function showGoogleCompleteForm() {
  try {
    const pending = await request('/api/seller/auth/google/pending');
    show('acctForms', false);
    show('googleComplete', true);
    setText('googleCompleteEmail', pending.email);
    const nameInput = document.querySelector('#googleCompleteForm [name="contactName"]');
    if (pending.name) nameInput.value = pending.name;
  } catch (error) {
    // The signed cookie expired, so there is nothing to finish.
    showNotice({ type: 'info', text: 'That Google sign-up expired. Please start again.' });
  }
}

async function submitGoogleComplete(event) {
  event.preventDefault();
  setText('googleCompleteError', '');
  const data = Object.fromEntries(new FormData(event.target));
  try {
    const result = await request('/api/seller/register/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    show('googleComplete', false);
    show('verifiedStep', true);
    setText('verifiedMessage', result.message);
  } catch (error) {
    setText('googleCompleteError', error.message);
  }
}

/* ---------- boot ---------- */
if (features.googleSignIn) show('googleAuthBlock', true);

showNotice(NOTICES[params.get('notice')]);
if (params.get('google') === 'complete') showGoogleCompleteForm();

wirePasswordStrength('registerPassword', 'registerPwStrength');

document.querySelectorAll('.acct-tab').forEach(button => button.addEventListener('click', () => setTab(button.dataset.tab)));

document.getElementById('loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  setText('loginError', '');
  const data = Object.fromEntries(new FormData(event.target));
  try {
    await request('/api/seller/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    window.location.href = '/seller/index.html';
  } catch (error) { setText('loginError', error.message); }
});

document.getElementById('registerForm').addEventListener('submit', async event => {
  event.preventDefault();
  setText('registerError', '');
  const data = Object.fromEntries(new FormData(event.target));
  if (data.password !== data.confirmPassword) return setText('registerError', 'Passwords do not match.');
  delete data.confirmPassword;
  try {
    const result = await request('/api/seller/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    // No email delivery on this store, so there is no code to ask for.
    if (!result.codeSent) {
      show('acctForms', false);
      show('verifiedStep', true);
      setText('verifiedMessage', result.message);
      return;
    }
    openVerifyStep(result.email, result.message);
  } catch (error) { setText('registerError', error.message); }
});

document.getElementById('otpForm').addEventListener('submit', verifyCode);
document.getElementById('otpResendBtn').addEventListener('click', sendCode);
document.getElementById('googleCompleteForm').addEventListener('submit', submitGoogleComplete);

// An existing seller who closed the tab mid-verification can get back in.
document.getElementById('verifyLaterLink').addEventListener('click', event => {
  event.preventDefault();
  clearInterval(resendTimer);
  show('verifyStep', false);
  show('acctForms', true);
  setTab('login');
});

document.getElementById('resumeVerifyLink').addEventListener('click', event => {
  event.preventDefault();
  const email = document.querySelector('#loginForm [name="email"]').value.trim();
  if (!email) {
    setText('loginError', 'Enter your email address first, then click the link again.');
    return;
  }
  openVerifyStep(email, '');
  sendCode();
});
