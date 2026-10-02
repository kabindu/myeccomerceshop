const $ = selector => document.querySelector(selector);
/* Currency and store name come from store.config.js, served to the
   browser as /store-config.js, so the dashboard follows whatever the
   storefront is configured to use. */
const storeConfig = window.STORE_CONFIG || {};
const storeName = storeConfig.name || 'this store';
const storeLocale = (storeConfig.currency && storeConfig.currency.locale) || 'en-US';
const money = value => {
  const symbol = (storeConfig.currency && storeConfig.currency.symbol) || '';
  const amount = Number(value || 0).toLocaleString(storeLocale);
  return symbol.length > 1 ? `${symbol} ${amount}` : `${symbol}${amount}`;
};
const state = { categories: [], brands: [], products: [], customers: [], orders: [], sellers: [], entityType: 'category', editingEntityId: null, editingProductId: null, viewingSellerId: null };
const SELLER_STATUS_PILL = { active: 'in', pending: 'low', suspended: 'out' };
const ORDER_STATUS_PILL = { paid: 'in', pending: 'low', cancelled: 'out' };

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

/* ensureNotifyStyles, showToast, confirmAction and readImage (further
   down this file) now live in js/dashboard-shared.js, shared with
   seller/js/seller.js and loaded before this file. */

function renderCategoryOptions() {
  const categoryOptions = state.categories.map(item => `<option value="${item.id}">${item.name}</option>`).join('');
  const brandOptions = state.brands.map(item => `<option value="${item.id}">${item.name}</option>`).join('');
  $('#categoryFilter').innerHTML = '<option value="all">All categories</option>' + categoryOptions;
  $('#brandCategoryField select').innerHTML = '<option value="">Select category</option>' + categoryOptions;
  $('#productForm [name="categoryId"]').innerHTML = '<option value="">Select category</option>' + categoryOptions;
  $('#productForm [name="brandId"]').innerHTML = '<option value="">Select brand</option>' + brandOptions;
}

function renderProducts() {
  const query = ($('#productSearch')?.value || '').toLowerCase();
  const category = $('#categoryFilter')?.value || 'all';
  const stock = $('#stockFilter')?.value || 'all';
  const products = state.products.filter(product => {
    const matchesQuery = [product.name, product.brand, product.category].some(value => (value || '').toLowerCase().includes(query));
    const matchesSeller = !state.viewingSellerId || product.seller_id === state.viewingSellerId;
    return matchesQuery && matchesSeller && (category === 'all' || String(product.category_id) === category) && (stock === 'all' || product.status === stock);
  });
  $('#productRows').innerHTML = products.map(product => `<tr><td class="check"><input type="checkbox" aria-label="Select ${product.name}"></td><td><div class="product-cell"><img class="product-thumb" src="${product.image || ''}" alt=""><div class="product-name"><strong>${product.name}</strong><small>${product.brand}${product.badge ? ` · ${product.badge}` : ''}</small></div></div></td><td><span class="category-pill">${product.category}</span></td><td class="price-cell">${money(product.price)}</td><td><span class="stock-pill ${product.status}">${product.status === 'out' ? 'Out of stock' : `${product.stock} in stock`}</span></td><td>${product.seller_name ? `<span class="category-pill">${product.seller_name}</span>` : '<small>Store</small>'}</td><td><span class="status-pill">Published</span></td><td><div class="row-actions"><button title="Edit product" data-edit-product="${product.id}">✎</button><button title="Delete product" data-delete-product="${product.id}">×</button></div></td></tr>`).join('');
  $('#productCount').textContent = products.length;
  $('#showingCount').textContent = products.length;
}

function renderEntities() {
  $('#categoryCards').innerHTML = state.categories.map(category => `<article class="entity-card"><div class="entity-top"><div class="entity-symbol">◈</div><div><button class="text-button" data-edit-category="${category.id}">Edit</button><button class="text-button" data-delete-category="${category.id}">Delete</button></div></div><h3>${category.name}</h3><p>Catalog category</p><footer><span>${state.products.filter(product => product.category_id === category.id).length} products</span><span>Active</span></footer></article>`).join('');
  $('#brandCards').innerHTML = state.brands.map(brand => `<article class="entity-card"><div class="entity-top"><div class="entity-symbol">${brand.name.slice(0, 2).toUpperCase()}</div><div><button class="text-button" data-edit-brand="${brand.id}">Edit</button><button class="text-button" data-delete-brand="${brand.id}">Delete</button></div></div><h3>${brand.name}</h3><p>${brand.category_name}</p><footer><span>${state.products.filter(product => product.brand_id === brand.id).length} products</span><span>Published</span></footer></article>`).join('');
}

async function loadCustomers() {
  const data = await request('/api/customers');
  state.customers = data.customers;
  renderCustomers();
}

function renderCustomers() {
  $('#customerRows').innerHTML = state.customers.map(customer => {
    const cartItems = (customer.cart || []).map(entry => {
      const product = state.products.find(item => item.id === Number(entry.productId));
      return product ? { name: product.name, qty: entry.qty, price: Number(product.price) } : null;
    }).filter(Boolean);
    const totalQty = cartItems.reduce((sum, item) => sum + item.qty, 0);
    const cartValue = cartItems.reduce((sum, item) => sum + item.price * item.qty, 0);
    const cartSummary = cartItems.length ? `${totalQty} item${totalQty === 1 ? '' : 's'} · ${money(cartValue)}` : 'Empty';
    const waDigits = (customer.phone || '').replace(/\D/g, '');
    const firstName = (customer.name || '').split(' ')[0];
    const waMessage = cartItems.length
      ? `Hello ${firstName}, this is ${storeName} — noticed you left ${cartItems.map(item => item.name).join(', ')} in your cart. Want a hand completing your order?`
      : `Hello ${firstName}, this is ${storeName} reaching out.`;
    const waHref = waDigits ? `https://wa.me/${waDigits}?text=${encodeURIComponent(waMessage)}` : '';
    const lastActivity = customer.cart_updated_at ? new Date(customer.cart_updated_at).toLocaleString(storeLocale, { dateStyle: 'medium', timeStyle: 'short' }) : '—';
    return `<tr>
      <td><div class="product-name"><strong>${customer.name}</strong><small>${customer.email}</small></div></td>
      <td>${customer.phone || '—'}</td>
      <td><span class="cart-pill ${cartItems.length ? 'has-items' : 'empty'}">${cartSummary}</span></td>
      <td>${lastActivity}</td>
      <td><div class="row-actions">${waHref ? `<a href="${waHref}" target="_blank" rel="noopener" title="Message on WhatsApp">💬</a>` : ''}</div></td>
    </tr>`;
  }).join('');
  $('#customerCount').textContent = state.customers.length;
}

/* Sales overview panel. Only paid orders count as revenue, and only the
   last 30 days, so the figures match what the orders table shows. */
function renderSalesSummary() {
  const panel = $('#salesSummary');
  if (!panel) return;
  const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const paid = state.orders.filter(order => order.status === 'paid' && new Date(order.created_at).getTime() >= since);
  if (!paid.length) {
    panel.innerHTML = '<p class="muted">No paid orders in the last 30 days yet.</p>';
    return;
  }
  const revenue = paid.reduce((total, order) => total + Number(order.subtotal || 0), 0);
  panel.innerHTML = [
    ['Revenue', money(revenue)],
    ['Paid orders', String(paid.length)],
    ['Average order', money(revenue / paid.length)],
  ].map(([label, value]) => `<div class="sales-row"><span>${label}</span><strong>${value}</strong></div>`).join('');
}

async function loadOrders() {
  const data = await request('/api/orders');
  state.orders = data.orders;
  $('#metricOrders').textContent = state.orders.filter(order => order.status === 'pending' || order.status === 'paid').length;
  renderSalesSummary();
  renderOrders();
}

function renderOrders() {
  const query = ($('#orderSearch')?.value || '').toLowerCase();
  const statusFilter = $('#orderStatusFilter')?.value || 'all';
  const orders = state.orders.filter(order => {
    const matchesQuery = [order.customer_name, order.customer_phone, String(order.id)].some(value => String(value || '').toLowerCase().includes(query));
    return matchesQuery && (statusFilter === 'all' || order.status === statusFilter);
  });
  $('#orderRows').innerHTML = orders.map(order => {
    const items = (order.items || []).map(entry => {
      const product = state.products.find(item => item.id === Number(entry.productId));
      return {
        name: product ? product.name : `Product #${entry.productId}`,
        qty: entry.qty,
        sellerId: product?.seller_id || null,
        sellerName: product?.seller_name || null,
      };
    });
    const itemsSummary = items.map(item => `${item.qty}× ${item.name}${item.sellerName ? ` (${item.sellerName})` : ''}`).join(', ');
    const sellersInvolved = [...new Map(items.filter(item => item.sellerId).map(item => [item.sellerId, item.sellerName])).entries()];
    const shopSummary = sellersInvolved.length ? sellersInvolved.map(([, name]) => name).join(', ') : 'Store';

    const waDigits = (order.customer_phone || '').replace(/\D/g, '');
    const waMessage = `Hello ${(order.customer_name || '').split(' ')[0]}, this is ${storeName} following up on order #${order.id} (${money(order.subtotal)}).`;
    const waHref = waDigits ? `https://wa.me/${waDigits}?text=${encodeURIComponent(waMessage)}` : '';

    const sellerButtons = sellersInvolved.map(([sellerId]) => {
      const seller = state.sellers.find(item => item.id === sellerId);
      const digits = (seller?.phone || '').replace(/\D/g, '');
      if (!digits) return '';
      const sellerItems = items.filter(item => item.sellerId === sellerId).map(item => `${item.qty}× ${item.name}`).join(', ');
      const message = `Hello ${seller.contact_name.split(' ')[0]}, you have a new order (#${order.id}) for ${sellerItems} - please prepare it for the customer.`;
      return `<a href="https://wa.me/${digits}?text=${encodeURIComponent(message)}" target="_blank" rel="noopener" title="Notify ${seller.business_name} on WhatsApp">🏪</a>`;
    }).join('');

    const date = new Date(order.created_at).toLocaleString(storeLocale, { dateStyle: 'medium', timeStyle: 'short' });
    // Every status this order could move to, so the shop owner can settle
    // or cancel it - there is no gateway to do that automatically.
    const statusOptions = ['pending', 'paid', 'cancelled']
      .map(value => `<option value="${value}"${order.status === value ? ' selected' : ''}>${value}</option>`)
      .join('');
    return `<tr>
      <td><strong>#${order.id}</strong></td>
      <td><div class="product-name"><strong>${order.customer_name}</strong><small>${order.customer_phone}</small></div></td>
      <td><span title="${itemsSummary}">${items.length} item${items.length === 1 ? '' : 's'}</span></td>
      <td>${sellersInvolved.length ? `<span class="category-pill" title="${shopSummary}">${shopSummary}</span>` : '<small>Store</small>'}</td>
      <td class="price-cell">${money(order.subtotal)}</td>
      <td><select class="order-status-select ${ORDER_STATUS_PILL[order.status] || 'low'}" data-order-id="${order.id}" data-current="${order.status}" aria-label="Order #${order.id} status">${statusOptions}</select></td>
      <td>${date}</td>
      <td><div class="row-actions">${waHref ? `<a href="${waHref}" target="_blank" rel="noopener" title="Message customer on WhatsApp">💬</a>` : ''}${sellerButtons}</div></td>
    </tr>`;
  }).join('');
  $('#orderCount').textContent = orders.length;
}

/* The server decides what stock change a transition implies, so this
   only says where the order should end up. On failure the select snaps
   back to the value it was showing. */
async function updateOrderStatus(select) {
  const status = select.value;
  const previousStatus = select.dataset.current;
  if (status === previousStatus) return;
  select.disabled = true;
  try {
    await request(`/api/orders/${select.dataset.orderId}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    showToast(`Order #${select.dataset.orderId} marked ${status}.`);
    await Promise.all([loadOrders(), loadCatalog()]);
  } catch (error) {
    select.value = previousStatus;
    showToast(error.message, 'error');
  } finally {
    select.disabled = false;
  }
}

async function loadSellers() {
  const data = await request('/api/sellers');
  state.sellers = data.sellers;
  renderSellers();
}

/* Email verification is tracked separately from approval, so this says
   what was checked and how, without implying either one gates the
   other. */
function verifiedPill(seller) {
  if (!seller.email_verified_at) return '<span class="verify-pill no">Not verified</span>';
  const how = seller.auth_provider === 'google' ? 'Google' : 'email code';
  return `<span class="verify-pill yes">Verified<small>${how}</small></span>`;
}

function renderSellers() {
  $('#sellerRows').innerHTML = state.sellers.map(seller => {
    const applied = new Date(seller.created_at).toLocaleDateString(storeLocale, { year: 'numeric', month: 'short', day: 'numeric' });
    const actions = [];
    if (seller.status === 'pending') actions.push(`<button title="Approve" data-seller-status="${seller.id}:active">✓</button>`);
    if (seller.status !== 'suspended') actions.push(`<button title="Suspend" data-seller-status="${seller.id}:suspended">⛔</button>`);
    if (seller.status === 'suspended') actions.push(`<button title="Reactivate" data-seller-status="${seller.id}:active">↺</button>`);
    return `<tr>
      <td><strong>${seller.business_name}</strong></td>
      <td><div class="product-name"><strong>${seller.contact_name}</strong><small>${seller.email}</small></div></td>
      <td>${seller.phone || '\u2014'}</td>
      <td><button class="text-button" data-view-seller-products="${seller.id}">${seller.product_count} product${Number(seller.product_count) === 1 ? '' : 's'}</button></td>
      <td>${verifiedPill(seller)}</td>
      <td><span class="stock-pill ${SELLER_STATUS_PILL[seller.status] || 'low'}">${seller.status}</span></td>
      <td>${applied}</td>
      <td><div class="row-actions">${actions.join('')}</div></td>
    </tr>`;
  }).join('');
  $('#sellerCount').textContent = state.sellers.length;
}

function viewSellerProducts(sellerId) {
  const seller = state.sellers.find(item => item.id === sellerId);
  if (!seller) return;
  state.viewingSellerId = sellerId;
  $('#sellerFilterBanner').hidden = false;
  $('#sellerFilterName').textContent = seller.business_name;
  $('#productsHeading').textContent = `${seller.business_name}'s products`;
  $('#productsSubheading').textContent = `Everything ${seller.business_name} has listed on the storefront.`;
  setView('products');
  renderProducts();
}

function clearSellerFilter() {
  state.viewingSellerId = null;
  $('#sellerFilterBanner').hidden = true;
  $('#productsHeading').textContent = 'Products';
  $('#productsSubheading').textContent = 'Manage everything that appears in your storefront.';
  renderProducts();
}

async function setSellerStatus(id, status) {
  const label = status === 'active' ? 'approve this seller' : status === 'suspended' ? 'suspend this seller' : 'update this seller';
  if (!(await confirmAction(`Are you sure you want to ${label}?`))) return;
  try {
    await request(`/api/sellers/${id}/status`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
    showToast(status === 'active' ? 'Seller approved.' : status === 'suspended' ? 'Seller suspended.' : 'Seller updated.');
    await loadSellers();
  } catch (error) { showToast(error.message, 'error'); }
}

function setView(view) {
  document.querySelectorAll('.view').forEach(section => section.classList.remove('active'));
  $(`#${view}View`).classList.add('active');
  document.querySelectorAll('.nav-item[data-view]').forEach(item => item.classList.toggle('active', item.dataset.view === view));
  $('#pageCrumb').textContent = view[0].toUpperCase() + view.slice(1);
  $('#sidebar').classList.remove('open');
}

function openEntityModal(type) {
  state.entityType = type;
  state.editingEntityId = null;
  const label = type === 'brand' ? 'brand' : 'category';
  $('#entityModalTitle').textContent = `Add ${label}`;
  $('#entityNameLabel').textContent = `${label[0].toUpperCase()}${label.slice(1)} name`;
  $('#brandCategoryField').style.display = type === 'brand' ? '' : 'none';
  $('#brandCategoryField select').required = type === 'brand';
  $('#entityForm button[type="submit"]').textContent = `Save ${label}`;
  $('#entityModal').classList.add('open');
  $('#entityModal').setAttribute('aria-hidden', 'false');
}

function editEntity(type, id) {
  const item = (type === 'category' ? state.categories : state.brands).find(value => value.id === Number(id));
  if (!item) return;
  state.editingEntityId = item.id;
  state.entityType = type;
  const label = type === 'brand' ? 'brand' : 'category';
  $('#entityModalTitle').textContent = `Edit ${label}`;
  $('#entityNameLabel').textContent = `${label[0].toUpperCase()}${label.slice(1)} name`;
  $('#brandCategoryField').style.display = type === 'brand' ? '' : 'none';
  $('#brandCategoryField select').required = type === 'brand';
  $('#entityForm [name="name"]').value = item.name;
  if (type === 'brand') $('#brandCategoryField select').value = item.category_id;
  $('#entityForm button[type="submit"]').textContent = `Update ${label}`;
  $('#entityModal').classList.add('open');
  $('#entityModal').setAttribute('aria-hidden', 'false');
}

function closeEntityModal() {
  $('#entityModal').classList.remove('open');
  $('#entityModal').setAttribute('aria-hidden', 'true');
  $('#entityForm').reset();
  state.editingEntityId = null;
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

async function deleteRecord(type, id, label) {
  if (!(await confirmAction(`Delete ${label}?`))) return;
  try {
    await request(`/api/${type}/${id}`, { method: 'DELETE' });
    showToast(`Deleted ${label}.`);
    await loadCatalog();
  } catch (error) { showToast(error.message, 'error'); }
}

async function loadCatalog() {
  const catalog = await request('/api/catalog');
  state.categories = catalog.categories;
  state.brands = catalog.brands;
  state.products = catalog.products;
  const catalogValue = state.products.reduce((total, product) => total + Number(product.price || 0), 0);
  const lowStock = state.products.filter(product => product.status === 'low' || product.status === 'out').length;
  $('#metricProducts').textContent = state.products.length;
  $('#metricValue').textContent = money(catalogValue);
  $('#metricLowStock').textContent = lowStock;
  $('#totalProductCount').textContent = state.products.length;
  renderCategoryOptions();
  renderProducts();
  renderEntities();
  renderActivity();
}

/* The catalog comes back newest-first, so the top few rows are the most
   recent additions. Real data only - this panel used to show a
   hardcoded feed that never changed. */
function renderActivity() {
  const list = $('#activityList');
  if (!list) return;
  const dots = ['green', 'orange', 'blue', 'purple'];
  if (!state.products.length) {
    list.innerHTML = '<p class="muted">No products yet. Add your first one to see it here.</p>';
    return;
  }
  list.innerHTML = state.products.slice(0, 4).map((product, index) => `
    <div class="activity"><span class="activity-dot ${dots[index % dots.length]}"></span>
      <div><strong>${product.name}</strong><p>${product.category} · ${money(product.price)}</p><small>${product.seller_name || 'Added by you'}</small></div>
    </div>`).join('');
}

document.querySelectorAll('.nav-item[data-view]').forEach(item => item.addEventListener('click', () => {
  if (item.dataset.view === 'products' && state.viewingSellerId) clearSellerFilter();
  setView(item.dataset.view);
}));
document.querySelectorAll('[data-view-target]').forEach(item => item.addEventListener('click', () => setView(item.dataset.viewTarget)));
document.querySelectorAll('[data-open-product]').forEach(button => button.addEventListener('click', () => openProductModal()));
document.querySelectorAll('[data-close-product]').forEach(button => button.addEventListener('click', closeProductModal));
document.querySelectorAll('[data-open-entity]').forEach(button => button.addEventListener('click', () => openEntityModal(button.dataset.openEntity)));
document.querySelectorAll('[data-close-entity]').forEach(button => button.addEventListener('click', closeEntityModal));
$('#clearSellerFilterBtn').addEventListener('click', clearSellerFilter);
$('#productModal').addEventListener('click', event => { if (event.target.id === 'productModal') closeProductModal(); });
$('#entityModal').addEventListener('click', event => { if (event.target.id === 'entityModal') closeEntityModal(); });
$('#productSearch').addEventListener('input', renderProducts);
$('#categoryFilter').addEventListener('change', renderProducts);
$('#stockFilter').addEventListener('change', renderProducts);
$('#orderSearch').addEventListener('input', renderOrders);
$('#orderStatusFilter').addEventListener('change', renderOrders);
$('#orderRows').addEventListener('change', event => {
  const select = event.target.closest('.order-status-select');
  if (select) updateOrderStatus(select);
});
$('#mobileMenu').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
$('#productForm [name="image"]').addEventListener('change', event => readImage(event.target, $('#productImagePreview')));
$('#productForm [name="image2"]').addEventListener('change', event => readImage(event.target, $('#productImagePreview2')));
$('#productForm [name="image3"]').addEventListener('change', event => readImage(event.target, $('#productImagePreview3')));
document.addEventListener('click', event => {
  const button = event.target.closest('[data-edit-category], [data-edit-brand], [data-delete-category], [data-delete-brand], [data-edit-product], [data-delete-product], [data-seller-status], [data-view-seller-products]');
  if (!button) return;
  if (button.dataset.editCategory) editEntity('category', button.dataset.editCategory);
  if (button.dataset.editBrand) editEntity('brand', button.dataset.editBrand);
  if (button.dataset.deleteCategory) deleteRecord('categories', button.dataset.deleteCategory, 'this category');
  if (button.dataset.deleteBrand) deleteRecord('brands', button.dataset.deleteBrand, 'this brand');
  if (button.dataset.editProduct) openProductModal(state.products.find(product => product.id === Number(button.dataset.editProduct)));
  if (button.dataset.deleteProduct) deleteRecord('products', button.dataset.deleteProduct, 'this product');
  if (button.dataset.sellerStatus) {
    const [id, status] = button.dataset.sellerStatus.split(':');
    setSellerStatus(id, status);
  }
  if (button.dataset.viewSellerProducts) viewSellerProducts(Number(button.dataset.viewSellerProducts));
});

$('#entityForm').addEventListener('submit', async event => {
  event.preventDefault();
  const data = new FormData(event.target);
  const entityType = state.entityType;
  const editingId = state.editingEntityId;
  const label = entityType === 'brand' ? 'Brand' : 'Category';
  closeEntityModal(); // close immediately so a second click can't submit the same form twice
  try {
    const resource = entityType === 'category' ? 'categories' : 'brands';
    const payload = entityType === 'category' ? { name: data.get('name') } : { name: data.get('name'), categoryId: data.get('category') };
    await request(`/api/${resource}${editingId ? `/${editingId}` : ''}`, { method: editingId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    showToast(editingId ? `${label} updated.` : `${label} added.`);
    await loadCatalog();
  } catch (error) { showToast(error.message, 'error'); }
});

$('#productForm').addEventListener('submit', async event => {
  event.preventDefault();
  const formData = new FormData(event.target);
  const editingId = state.editingProductId;
  closeProductModal(); // close immediately so a second click can't submit the same form twice
  try {
    await request(`/api/products${editingId ? `/${editingId}` : ''}`, { method: editingId ? 'PUT' : 'POST', body: formData });
    showToast(editingId ? 'Product updated.' : 'Product added.');
    await loadCatalog();
  } catch (error) { showToast(error.message, 'error'); }
});

const sellersPromise = loadSellers().catch(error => console.error('Could not load sellers:', error));
loadCatalog()
  .then(() => Promise.all([
    loadCustomers().catch(error => console.error('Could not load customers:', error)),
    loadOrders().catch(error => console.error('Could not load orders:', error)),
  ]))
  .then(() => sellersPromise)
  .then(() => renderOrders()) // sellers may still have resolved after orders did - re-render so the seller WhatsApp buttons show up
  .catch(error => showToast(`Could not connect to the catalog database: ${error.message}`, 'error'));