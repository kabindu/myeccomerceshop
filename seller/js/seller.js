const $ = selector => document.querySelector(selector);
/* Currency comes from store.config.js, served to the browser as
   /store-config.js, so the dashboard shows prices the same way the
   storefront does. */
const storeConfig = window.STORE_CONFIG || {};
const storeLocale = (storeConfig.currency && storeConfig.currency.locale) || 'en-US';
const money = value => {
  const symbol = (storeConfig.currency && storeConfig.currency.symbol) || '';
  const amount = Number(value || 0).toLocaleString(storeLocale);
  return symbol.length > 1 ? `${symbol} ${amount}` : `${symbol}${amount}`;
};
const state = { categories: [], brands: [], products: [], editingProductId: null };

async function request(url, options = {}) {
  const response = await fetch(url, options);
  if (response.status === 401) { window.location.href = '/seller/login.html'; throw new Error('Not signed in.'); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

/* ensureNotifyStyles, showToast, confirmAction and readImage (further
   down this file) now live in js/dashboard-shared.js, shared with
   admin/js/admin.js and loaded before this file. */

/* Shown only to a seller whose email is still unverified. Approval does
   not depend on it, so this asks rather than blocks. */
function setupVerifyBanner(seller) {
  const banner = $('#verifyBanner');
  if (!banner || seller.emailVerified) return;
  banner.hidden = false;

  const status = $('#verifyStatus');
  const sendBtn = $('#verifySendBtn');
  const submitBtn = $('#verifySubmitBtn');
  const input = $('#verifyCodeInput');

  const post = (url, body) => request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: seller.email, ...body }),
  });

  sendBtn.addEventListener('click', async () => {
    status.textContent = '';
    sendBtn.disabled = true;
    try {
      const data = await post('/api/seller/otp/send', {});
      status.textContent = data.message;
      input.focus();
      // The server throttles per account, so match that wait here rather
      // than letting someone hammer the button for nothing.
      let left = data.resendAfter || 60;
      const tick = setInterval(() => {
        sendBtn.textContent = left > 0 ? `Resend (${left}s)` : 'Send code';
        if (left <= 0) { clearInterval(tick); sendBtn.disabled = false; }
        left -= 1;
      }, 1000);
      sendBtn.textContent = `Resend (${left}s)`;
    } catch (error) {
      status.textContent = error.message;
      sendBtn.disabled = false;
    }
  });

  submitBtn.addEventListener('click', async () => {
    const code = input.value.replace(/[^0-9]/g, '');
    if (code.length !== 6) { status.textContent = 'Enter the 6-digit code from your email.'; return; }
    submitBtn.disabled = true;
    try {
      await post('/api/seller/otp/verify', { code });
      banner.hidden = true;
      showToast('Email verified.');
    } catch (error) {
      status.textContent = error.message;
    } finally {
      submitBtn.disabled = false;
    }
  });
}

function renderCategoryOptions() {
  $('#productForm [name="categoryId"]').innerHTML = '<option value="">Select category</option>' + state.categories.map(item => `<option value="${item.id}">${item.name}</option>`).join('');
  $('#productForm [name="brandId"]').innerHTML = '<option value="">Select brand</option>' + state.brands.map(item => `<option value="${item.id}">${item.name}</option>`).join('');
}

function renderProducts() {
  const query = ($('#productSearch')?.value || '').toLowerCase();
  const products = state.products.filter(product => [product.name, product.brand, product.category].some(value => (value || '').toLowerCase().includes(query)));
  $('#productRows').innerHTML = products.map(product => `<tr><td><div class="product-cell"><img class="product-thumb" src="${product.image || ''}" alt=""><div class="product-name"><strong>${product.name}</strong><small>${product.brand}${product.badge ? ` · ${product.badge}` : ''}</small></div></div></td><td><span class="category-pill">${product.category}</span></td><td class="price-cell">${money(product.price)}</td><td><span class="stock-pill ${product.status}">${product.status === 'out' ? 'Out of stock' : `${product.stock} in stock`}</span></td><td><div class="row-actions"><button title="Edit product" data-edit-product="${product.id}">&#9998;</button><button title="Delete product" data-delete-product="${product.id}">&times;</button></div></td></tr>`).join('');
  $('#productCount').textContent = products.length;
}

function openProductModal(product = null) {
  state.editingProductId = product ? product.id : null;
  $('#productModal').classList.add('open');
  $('#productModal').setAttribute('aria-hidden', 'false');
  $('#modalTitle').textContent = product ? 'Edit product' : 'Add product';
  $('#productForm button[type="submit"]').textContent = product ? 'Update product' : 'Save product';
  if (product) {
    Object.entries({ name: product.name, categoryId: product.category_id, brandId: product.brand_id, price: product.price, originalPrice: product.originalPrice, stock: product.stock, badge: product.badge, spec: product.spec, description: product.description }).forEach(([name, value]) => {
      const input = $(`#productForm [name="${name}"]`);
      if (input) input.value = value ?? '';
    });
    [['#productImagePreview', product.image], ['#productImagePreview2', product.image2], ['#productImagePreview3', product.image3]].forEach(([selector, src]) => {
      if (src) { $(selector).src = src; $(selector).classList.add('visible'); }
    });
  }
}

function closeProductModal() {
  $('#productModal').classList.remove('open');
  $('#productModal').setAttribute('aria-hidden', 'true');
  $('#productForm').reset();
  ['#productImagePreview', '#productImagePreview2', '#productImagePreview3'].forEach(selector => $(selector).classList.remove('visible'));
  state.editingProductId = null;
}

async function deleteProduct(id) {
  if (!(await confirmAction('Delete this product?'))) return;
  try {
    await request(`/api/seller/products/${id}`, { method: 'DELETE' });
    showToast('Product deleted.');
    await loadProducts();
  } catch (error) { showToast(error.message, 'error'); }
}

async function loadCatalogOptions() {
  const catalog = await request('/api/taxonomy');
  state.categories = catalog.categories;
  state.brands = catalog.brands;
  renderCategoryOptions();
}

async function loadProducts() {
  const data = await request('/api/seller/products');
  state.products = data.products;
  renderProducts();
}

async function loadSellerProfile() {
  const seller = await request('/api/seller/me');
  $('#sellerBusinessName').textContent = seller.business_name;
  $('#sellerContactName').textContent = seller.contact_name;
  $('#sellerEmail').textContent = seller.email;
  $('#sellerAvatar').textContent = seller.business_name.slice(0, 2).toUpperCase();
  setupVerifyBanner(seller);
}

document.querySelectorAll('[data-open-product]').forEach(button => button.addEventListener('click', () => openProductModal()));
document.querySelectorAll('[data-close-product]').forEach(button => button.addEventListener('click', closeProductModal));
$('#productModal').addEventListener('click', event => { if (event.target.id === 'productModal') closeProductModal(); });
$('#productSearch').addEventListener('input', renderProducts);
$('#mobileMenu').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
$('#productForm [name="image"]').addEventListener('change', event => readImage(event.target, $('#productImagePreview')));
$('#productForm [name="image2"]').addEventListener('change', event => readImage(event.target, $('#productImagePreview2')));
$('#productForm [name="image3"]').addEventListener('change', event => readImage(event.target, $('#productImagePreview3')));
$('#sellerLogoutBtn').addEventListener('click', async () => {
  await request('/api/seller/logout', { method: 'POST' }).catch(() => {});
  window.location.href = '/seller/login.html';
});
document.addEventListener('click', event => {
  const button = event.target.closest('[data-edit-product], [data-delete-product]');
  if (!button) return;
  if (button.dataset.editProduct) openProductModal(state.products.find(product => product.id === Number(button.dataset.editProduct)));
  if (button.dataset.deleteProduct) deleteProduct(button.dataset.deleteProduct);
});

$('#productForm').addEventListener('submit', async event => {
  event.preventDefault();
  const formData = new FormData(event.target);
  const editingId = state.editingProductId;
  closeProductModal(); // close immediately so a second click can't submit the same form twice
  try {
    await request(`/api/seller/products${editingId ? `/${editingId}` : ''}`, { method: editingId ? 'PUT' : 'POST', body: formData });
    showToast(editingId ? 'Product updated.' : 'Product added.');
    await loadProducts();
  } catch (error) { showToast(error.message, 'error'); }
});

Promise.all([loadSellerProfile(), loadCatalogOptions(), loadProducts()])
  .catch(error => { if (error.message !== 'Not signed in.') showToast(`Could not load your dashboard: ${error.message}`, 'error'); });
