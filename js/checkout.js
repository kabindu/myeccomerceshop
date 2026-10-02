/* ============================================================
   CHECKOUT PAGE — order summary, delivery details, and placing the
   order.

   There is no payment gateway: the order is recorded and the shop
   owner arranges payment their own way, then marks it paid from the
   admin dashboard. The server re-prices every line and re-checks
   stock when the order is submitted, so nothing here is trusted.
   ============================================================ */
const CART_STORAGE_KEY = 'store_cart';

/* Prices follow the currency set in store.config.js, served to the
   browser as /store-config.js. */
function fmt(n){
  const currency = (window.STORE_CONFIG && window.STORE_CONFIG.currency) || { symbol: '$', locale: 'en-US' };
  const symbol = currency.symbol || '';
  const amount = Math.round(Number(n || 0)).toLocaleString(currency.locale || 'en-US');
  return symbol.length > 1 ? `${symbol} ${amount}` : `${symbol}${amount}`;
}

let cart = JSON.parse(localStorage.getItem(CART_STORAGE_KEY) || '{}');
let products = [];
let currentSubtotal = 0;
let orderPlaced = false;

function productImage(product){
  return product.image
    ? `<img src="${product.image}" alt="${product.name}" loading="lazy">`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="3"/></svg>`;
}

function renderItems(){
  const wrap = document.getElementById('checkoutItems');
  const ids = Object.keys(cart);
  if(!ids.length){
    wrap.innerHTML = `<div class="cart-empty">Your cart is empty.</div>`;
    return 0;
  }
  let subtotal = 0;
  wrap.innerHTML = ids.map(id=>{
    const product = products.find(p=>String(p.id)===String(id));
    if(!product) return '';
    const qty = cart[id];
    subtotal += product.price * qty;
    return `<div class="checkout-item-row">
      <div class="checkout-item-media">${productImage(product)}</div>
      <div class="checkout-item-info">
        <span class="ti">${product.name}</span>
        <span class="tb">${product.brand} &middot; Qty ${qty}</span>
      </div>
      <div class="checkout-item-price">${fmt(product.price * qty)}</div>
    </div>`;
  }).join('');
  return subtotal;
}

function updateSummary(){
  const subtotal = renderItems();
  currentSubtotal = subtotal;
  document.getElementById('sumSubtotal').textContent = fmt(subtotal);
  document.getElementById('sumTotal').textContent = fmt(subtotal);
  return subtotal;
}

function setStatus(message, type){
  const el = document.getElementById('payStatus');
  el.hidden = !message;
  el.textContent = message;
  el.className = `pay-status ${type || 'info'}`;
}

function setModalStatus(message, type){
  const el = document.getElementById('orderModalStatus');
  el.hidden = !message;
  el.textContent = message;
  el.className = `pay-status ${type || 'info'}`;
}

function markFieldError(id, hasError){
  document.getElementById(id).closest('.field').classList.toggle('field-error', hasError);
}

function openModal(){ document.getElementById('orderModalOverlay').hidden = false; }
function closeModal(){ document.getElementById('orderModalOverlay').hidden = true; }

function customerDetails(){
  return {
    name: document.getElementById('custName').value.trim(),
    phone: document.getElementById('custPhone').value.trim(),
    email: document.getElementById('custEmail').value.trim(),
    address: document.getElementById('custAddress').value.trim(),
  };
}

/* Mirrors the server's own check (7-15 digits, country code optional)
   rather than assuming a single country's format. */
function validateForm(){
  const details = customerDetails();
  const digits = details.phone.replace(/[^0-9]/g, '');
  const phoneValid = digits.length >= 7 && digits.length <= 15;
  markFieldError('custName', details.name.length < 2);
  markFieldError('custPhone', !phoneValid);
  markFieldError('custAddress', !details.address);
  return details.name.length >= 2 && phoneValid && Boolean(details.address);
}

function showConfirmView(){
  const details = customerDetails();
  document.getElementById('confirmName').textContent = details.name;
  document.getElementById('confirmPhone').textContent = details.phone;
  document.getElementById('confirmAddress').textContent = details.address;
  document.getElementById('confirmTotal').textContent = fmt(currentSubtotal);
  document.getElementById('orderConfirmView').hidden = false;
  document.getElementById('orderSuccessView').hidden = true;
  document.getElementById('orderModalTitle').textContent = 'Confirm your order';
  setModalStatus('');
}

function showSuccessView(data){
  orderPlaced = true;
  cart = {};
  localStorage.removeItem(CART_STORAGE_KEY);
  document.getElementById('orderSuccessNumber').textContent = `#${data.orderId}`;
  document.getElementById('orderSuccessAmount').textContent = fmt(data.amount != null ? data.amount : currentSubtotal);
  document.getElementById('orderConfirmView').hidden = true;
  document.getElementById('orderSuccessView').hidden = false;
  document.getElementById('orderModalTitle').textContent = 'Order placed';
  document.getElementById('orderSuccessTitle').focus();
  // Only offer "View my orders" to someone who can actually see them.
  fetch('/api/account/me').then(response => { document.getElementById('orderViewOrders').hidden = !response.ok; }).catch(() => {});
}

async function placeOrder(){
  const button = document.getElementById('orderConfirmBtn');
  button.disabled = true;
  setModalStatus('Placing your order...', 'info');
  const items = Object.entries(cart).map(([id, qty]) => ({ productId: Number(id), qty }));
  try {
    const response = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customer: customerDetails(), items }),
    });
    const data = await response.json();
    if(!response.ok) throw new Error(data.error || 'Could not place the order.');
    setModalStatus('');
    showSuccessView(data);
  } catch(error){
    // Usually a stock or price change since the cart was filled, so the
    // server's own message is the useful one to show.
    setModalStatus(error.message, 'error');
    button.disabled = false;
  }
}

// Once the order is in, the cart is empty and this page has nothing left
// to show, so dismissing the popup goes back to the shop.
function dismissModal(){
  if(orderPlaced){ window.location.href = 'index.html'; return; }
  closeModal();
}

function handlePlaceOrderClick(){
  if(!Object.keys(cart).length) return;
  if(!validateForm()){
    setStatus('Please fill in all required fields correctly.', 'error');
    const firstInvalid = document.querySelector('.field-error input, .field-error textarea');
    if(firstInvalid){ firstInvalid.scrollIntoView({ behavior:'smooth', block:'center' }); firstInvalid.focus(); }
    return;
  }
  setStatus('');
  showConfirmView();
  openModal();
}

async function boot(){
  if(!Object.keys(cart).length){
    window.location.href = 'index.html';
    return;
  }
  try {
    const response = await fetch('/api/catalog/light');
    const catalog = await response.json();
    products = catalog.products.map(product => ({
      id: product.id,
      name: product.name,
      brand: product.brand,
      price: Number(product.price),
      image: product.image,
    }));
  } catch(error){
    console.error(error);
  }
  updateSummary();
  document.getElementById('payBtn').addEventListener('click', handlePlaceOrderClick);
  document.getElementById('orderConfirmBtn').addEventListener('click', placeOrder);
  document.getElementById('orderEditBtn').addEventListener('click', closeModal);
  document.getElementById('orderModalClose').addEventListener('click', dismissModal);
  document.getElementById('orderModalOverlay').addEventListener('click', e=>{ if(e.target.id === 'orderModalOverlay') dismissModal(); });
}

boot();
