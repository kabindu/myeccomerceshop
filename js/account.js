/* ============================================================
   ACCOUNT PAGE — sign in / register / order history. Kept simple:
   no email verification, no password reset, just a signed cookie
   session (see server.js). Guests never need this page — cart and
   recently-viewed already persist without an account.
   ============================================================ */
/* request(), passwordStrength() and wirePasswordStrength() now live in
   js/password-strength.js (shared with seller/login.html), loaded
   before this file. */

function setTab(tab){
  document.querySelectorAll('.acct-tab').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tab));
  document.getElementById('loginForm').hidden = tab !== 'login';
  document.getElementById('registerForm').hidden = tab !== 'register';
}

function renderOrders(orders){
  const wrap = document.getElementById('acctOrders');
  if(!orders.length){
    wrap.innerHTML = `<div class="acct-empty">No orders yet. Once you check out, your orders will show up here.</div>`;
    return;
  }
  wrap.innerHTML = orders.map(order => {
    const itemCount = (order.items || []).reduce((sum, item) => sum + (item.qty || 1), 0);
    const locale = (window.STORE_CONFIG && window.STORE_CONFIG.currency && window.STORE_CONFIG.currency.locale) || 'en-US';
    const date = new Date(order.created_at).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
    return `<div class="acct-order-row">
      <div>
        <strong>Order #${order.id}</strong>
        <span class="acct-order-meta">${date} &middot; ${itemCount} item${itemCount === 1 ? '' : 's'}</span>
      </div>
      <div class="acct-order-right">
        <span class="acct-order-status ${order.status}">${order.status}</span>
        <strong>${fmt(order.subtotal)}</strong>
      </div>
    </div>`;
  }).join('');
}

async function showSignedIn(customer){
  document.getElementById('acctAuth').hidden = true;
  document.getElementById('acctOverview').hidden = false;
  document.getElementById('acctName').textContent = customer.name;
  document.getElementById('acctMeta').textContent = [customer.email, customer.phone].filter(Boolean).join(' · ');
  try {
    const { orders } = await request('/api/account/orders');
    renderOrders(orders);
  } catch(error){
    document.getElementById('acctOrders').innerHTML = `<div class="acct-empty">Could not load your orders right now.</div>`;
  }
}

function showSignedOut(){
  document.getElementById('acctOverview').hidden = true;
  document.getElementById('acctAuth').hidden = false;
}

document.querySelectorAll('.acct-tab').forEach(btn => btn.addEventListener('click', () => setTab(btn.dataset.tab)));

document.getElementById('loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  const errorEl = document.getElementById('loginError');
  errorEl.textContent = '';
  const data = Object.fromEntries(new FormData(event.target));
  try {
    const customer = await request('/api/account/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    await showSignedIn(customer);
  } catch(error){ errorEl.textContent = error.message; }
});

wirePasswordStrength('registerPassword', 'registerPwStrength');

document.getElementById('registerForm').addEventListener('submit', async event => {
  event.preventDefault();
  const errorEl = document.getElementById('registerError');
  errorEl.textContent = '';
  const data = Object.fromEntries(new FormData(event.target));
  if(data.password !== data.confirmPassword){
    errorEl.textContent = 'Passwords do not match.';
    return;
  }
  delete data.confirmPassword;
  try {
    const customer = await request('/api/account/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    await showSignedIn(customer);
  } catch(error){ errorEl.textContent = error.message; }
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await request('/api/account/logout', { method: 'POST' });
  showSignedOut();
});

(async function boot(){
  try {
    const customer = await request('/api/account/me');
    await showSignedIn(customer);
  } catch(error){
    showSignedOut();
  }
})();
