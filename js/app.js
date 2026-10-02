/* ============================================================
   STOREFRONT — catalog, filters, cart and recently viewed.

   imagesForProduct, storefrontCategoryId, fmt, starsSVG and
   productImage all live in js/catalog-shared.js (loaded before
   this file) so the product detail page can reuse them too.
   ============================================================ */

function renderSkeletonGrid(count = 9){
  const grid = document.getElementById('productGrid');
  if(!grid) return;
  grid.innerHTML = Array.from({length: count}).map(() => `
    <article class="card skeleton-card">
      <div class="card-media skeleton-block"></div>
      <div class="card-body">
        <div class="skeleton-line" style="width:35%;height:8px;"></div>
        <div class="skeleton-line" style="width:90%;"></div>
        <div class="skeleton-line" style="width:50%;"></div>
        <div class="skeleton-line" style="width:40%;height:16px;margin-top:4px;"></div>
      </div>
    </article>`).join('');
}

/* A transient blip (one dropped request, a cold-starting database)
   shouldn't empty the shop. Retrying a couple of times rides out most
   of them; if it still fails, bootStorefront() below shows an honest
   error rather than an empty grid that looks like a store with
   nothing in it. */
async function fetchCatalogWithRetry(attempts = 3){
  let lastError;
  for(let attempt = 0; attempt < attempts; attempt++){
    try {
      const response = await fetch('/api/catalog/light');
      if(!response.ok) throw new Error('Could not load the catalog.');
      return await response.json();
    } catch(error){
      lastError = error;
      if(attempt < attempts - 1) await new Promise(resolve => setTimeout(resolve, 600 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function loadStorefrontCatalog(){
  const catalog = await fetchCatalogWithRetry();
  const categoryMap = new Map(catalog.categories.map(category => [category.id, storefrontCategoryId(category.name)]));
  CATEGORIES = catalog.categories.map(category => ({
    id: categoryMap.get(category.id),
    dbId: category.id,
    name: category.name,
  }));
  BRANDS_BY_CAT = {};
  catalog.brands.forEach(brand => {
    const categoryId = categoryMap.get(brand.category_id);
    if(!BRANDS_BY_CAT[categoryId]) BRANDS_BY_CAT[categoryId] = [];
    BRANDS_BY_CAT[categoryId].push(brand.name);
  });
  const categoryNames = new Map(catalog.categories.map(category => [category.id, category.name]));
  PRODUCTS = catalog.products.map(product => {
    const category = storefrontCategoryId(categoryNames.get(product.category_id) || product.category || 'equipment');
    return {
      id: String(product.id),
      name: product.name,
      category,
      brand: product.brand,
      price: Number(product.price),
      rating: Number(product.rating) || 0,
      reviews: Number(product.reviews) || 0,
      spec: product.spec || '',
      originalPrice: product.originalPrice ? Number(product.originalPrice) : null,
      badge: product.badge || null,
      status: product.status,
      stockQty: Number(product.stock) || 0,
      newArrival: false,
      image: product.image || null,
      categoryId: product.category_id,
      brandId: product.brand_id,
    };
  });
}

/* ============================================================
   DATA — all three are filled in by loadStorefrontCatalog() above
   from your own database. Nothing is hardcoded here, so an empty
   database shows an empty shop rather than sample products nobody
   can buy.
   ============================================================ */
let CATEGORIES = [];
let BRANDS_BY_CAT = {};
let PRODUCTS = [];

/* ============================================================
   STATE
   ============================================================ */
const state = {
  search: '',
  category: 'all',
  brands: new Set(),
  priceMin: null,
  priceMax: null,
  minRating: 0,
  sort: 'featured',
};
let cart = JSON.parse(localStorage.getItem(CART_STORAGE_KEY) || '{}'); // id -> qty
let currentCustomer = null;

/* ============================================================
   HELPERS
   ============================================================ */
const USD_TO_KES = 1;
const catName = id => (CATEGORIES.find(c=>c.id===id)||{}).name || id;

/* ============================================================
   INIT STATIC UI (category strip, tiles, filter category list, search select)
   ============================================================ */
function initStaticUI(){
  // category strip
  const strip = document.getElementById('catStrip');
  strip.innerHTML = `<button data-cat="all" class="active">All Categories</button>` +
    CATEGORIES.map(c=>`<button data-cat="${c.id}">${c.name}</button>`).join('');
  strip.addEventListener('click', e=>{
    const btn = e.target.closest('button[data-cat]');
    if(!btn) return;
    setCategory(btn.dataset.cat);
    document.getElementById('shop').scrollIntoView({behavior:'smooth'});
  });

  // search category select
  document.getElementById('searchCategorySelect').innerHTML =
    `<option value="all">All categories</option>` +
    CATEGORIES.map(c=>`<option value="${c.id}">${c.name}</option>`).join('');

  // filter: category checkboxes
  renderCategoryFilter();

  initHelpPanel();
}

/* ============================================================
   HELP PANEL (header "Help" icon + footer "Help Center" link)
   ============================================================ */
function initHelpPanel(){
  const panel = document.getElementById('helpPanel');
  const toggleBtn = document.getElementById('helpToggleBtn');
  const closeBtn = document.getElementById('helpCloseBtn');
  const footerLink = document.getElementById('footerHelpLink');
  if(!panel || !toggleBtn) return;

  function openHelp(){
    panel.hidden = false;
    toggleBtn.setAttribute('aria-expanded', 'true');
  }
  function closeHelp(){
    panel.hidden = true;
    toggleBtn.setAttribute('aria-expanded', 'false');
  }

  toggleBtn.addEventListener('click', e=>{
    e.stopPropagation();
    panel.hidden ? openHelp() : closeHelp();
  });
  closeBtn.addEventListener('click', closeHelp);
  footerLink?.addEventListener('click', e=>{ e.preventDefault(); openHelp(); });
  document.addEventListener('click', e=>{
    if(!panel.hidden && !panel.contains(e.target) && e.target !== toggleBtn) closeHelp();
  });
  document.addEventListener('keydown', e=>{ if(e.key === 'Escape') closeHelp(); });
}

function renderCategoryFilter(){
  const wrap = document.getElementById('filterCategory');
  wrap.innerHTML = CATEGORIES.map(c=>{
    const count = PRODUCTS.filter(p=>p.category===c.id).length;
    return `<label class="check-row">
      <input type="radio" name="catFilter" value="${c.id}" ${state.category===c.id?'checked':''}>
      ${c.name} <span class="cnt">${count}</span>
    </label>`;
  }).join('') + `<label class="check-row">
      <input type="radio" name="catFilter" value="all" ${state.category==='all'?'checked':''}>
      All categories <span class="cnt">${PRODUCTS.length}</span>
    </label>`;
  wrap.querySelectorAll('input').forEach(inp=>{
    inp.addEventListener('change', ()=> setCategory(inp.value));
  });
}

function renderBrandFilter(){
  const wrap = document.getElementById('filterBrand');
  const pool = state.category==='all'
    ? [...new Set(PRODUCTS.map(p=>p.brand))].sort()
    : (BRANDS_BY_CAT[state.category]||[]).slice().sort();

  wrap.innerHTML = pool.map(b=>{
    const count = PRODUCTS.filter(p=> p.brand===b && (state.category==='all'||p.category===state.category)).length;
    const checked = state.brands.has(b) ? 'checked' : '';
    return `<label class="check-row">
      <input type="checkbox" value="${b}" ${checked}> ${b} <span class="cnt">${count}</span>
    </label>`;
  }).join('');

  wrap.querySelectorAll('input').forEach(inp=>{
    inp.addEventListener('change', ()=>{
      if(inp.checked) state.brands.add(inp.value); else state.brands.delete(inp.value);
      renderAll();
    });
  });
}

function renderRatingFilter(){
  const wrap = document.getElementById('filterRating');
  const options = [4,3,2];
  wrap.innerHTML = options.map(r=>`
    <div class="rating-row ${state.minRating===r?'active':''}" data-r="${r}">
      <span class="stars">${starsSVG(r)}</span> &amp; up
    </div>`).join('') + `<div class="rating-row ${state.minRating===0?'active':''}" data-r="0">Any rating</div>`;
  wrap.querySelectorAll('.rating-row').forEach(row=>{
    row.addEventListener('click', ()=>{
      state.minRating = Number(row.dataset.r);
      renderAll();
    });
  });
}

function setCategory(cat){
  state.category = cat;
  state.brands.clear(); // reset brand filter when switching category context
  renderAll();
}

/* ============================================================
   ACTIVE CHIPS
   ============================================================ */
function renderChips(){
  const chips = [];
  if(state.category!=='all') chips.push({label:catName(state.category), clear:()=>setCategory('all')});
  state.brands.forEach(b=> chips.push({label:b, clear:()=>{state.brands.delete(b); renderAll();}}));
  if(state.priceMin || state.priceMax) chips.push({label:`${fmt(state.priceMin||0)} &ndash; ${state.priceMax ? fmt(state.priceMax) : 'No limit'}`, clear:()=>{state.priceMin=null;state.priceMax=null;document.getElementById('priceMin').value='';document.getElementById('priceMax').value='';renderAll();}});
  if(state.minRating>0) chips.push({label:`${state.minRating}&#9733; & up`, clear:()=>{state.minRating=0;renderAll();}});
  if(state.search) chips.push({label:`"${state.search}"`, clear:()=>{state.search='';document.getElementById('searchInput').value='';renderAll();}});

  const wrap = document.getElementById('activeChips');
  wrap.innerHTML = chips.map((c,i)=>`<span class="chip" data-i="${i}">${c.label}<button aria-label="Remove filter">&times;</button></span>`).join('');
  wrap.querySelectorAll('.chip button').forEach((btn,i)=> btn.addEventListener('click', ()=> chips[i].clear()));
}

/* ============================================================
   FILTER + SORT + RENDER PRODUCTS
   ============================================================ */
function getFiltered(){
  let list = PRODUCTS.filter(p=>{
    if(state.category!=='all' && p.category!==state.category) return false;
    if(state.brands.size && !state.brands.has(p.brand)) return false;
    if(state.priceMin!=null && p.price < state.priceMin) return false;
    if(state.priceMax!=null && p.price > state.priceMax) return false;
    if(state.minRating>0 && p.rating < state.minRating) return false;
    if(state.search){
      const q = state.search.toLowerCase();
      if(!(p.name.toLowerCase().includes(q) || p.brand.toLowerCase().includes(q) || catName(p.category).toLowerCase().includes(q))) return false;
    }
    return true;
  });

  switch(state.sort){
    case 'price-asc': list.sort((a,b)=>a.price-b.price); break;
    case 'price-desc': list.sort((a,b)=>b.price-a.price); break;
    case 'rating': list.sort((a,b)=>b.rating-a.rating); break;
    case 'newest': list.sort((a,b)=>(b.newArrival===true)-(a.newArrival===true)); break;
    default: break;
  }
  return list;
}

function productCard(pr){
  const discount = pr.originalPrice ? Math.round(100*(1-pr.price/pr.originalPrice)) : null;
  const inCart = !!cart[pr.id];
  const outOfStock = pr.status === 'out';
  const atStockCap = typeof pr.stockQty === 'number' && pr.stockQty > 0 && (cart[pr.id]||0) >= pr.stockQty;
  return `<article class="card" data-id="${pr.id}">
    <div class="card-media">
      ${pr.badge ? `<span class="card-badge ${pr.badge==='Best Seller'?'':''}">${pr.badge}</span>` : (pr.newArrival ? `<span class="card-badge sale">New</span>` : '')}
      ${discount ? `<span class="card-discount">-${discount}%</span>` : ''}
      ${productImage(pr.category, pr.name, pr.image)}
    </div>
    <div class="card-body">
      <div class="card-brand">${pr.brand}</div>
      <div class="card-title">${pr.name}</div>
      <div class="card-spec mono">${pr.spec}</div>
      <div class="card-rating"><span class="stars">${starsSVG(pr.rating,13)}</span> ${pr.rating} <span class="review-count" style="color:var(--text-faint)">(${pr.reviews})</span></div>
      <div class="card-price-row">
        <span class="card-price">${fmt(pr.price)}</span>
        ${pr.originalPrice ? `<span class="card-price-old">${fmt(pr.originalPrice)}</span>` : ''}
      </div>
      <span class="card-stock ${outOfStock?'low':''}">${outOfStock ? 'Out of stock' : 'In stock'}</span>
      <div class="card-actions">
        <button class="add-btn ${inCart?'added':''}" data-id="${pr.id}" ${outOfStock || atStockCap ? 'disabled' : ''}>${outOfStock ? 'Out of stock' : (inCart? 'Added &#10003;' : 'Add to Cart')}</button>
        ${whatsappOrderUrl(pr.name) ? `<a class="quote-btn whatsapp-btn" href="${whatsappOrderUrl(pr.name)}" target="_blank" rel="noopener" title="Order via WhatsApp" aria-label="Order via WhatsApp">${WHATSAPP_ICON_SVG}</a>` : ''}
      </div>
    </div>
  </article>`;
}

function renderProducts(){
  const list = getFiltered();
  document.getElementById('resultsNum').textContent = list.length;
  const grid = document.getElementById('productGrid');
  if(!list.length){
    grid.innerHTML = `<div class="empty-state">
      <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <h3>No gear matches those filters</h3><p>Try clearing a filter or searching a different term.</p>
    </div>`;
    return;
  }
  grid.innerHTML = list.map(productCard).join('');
  grid.querySelectorAll('.add-btn').forEach(btn=>{
    btn.addEventListener('click', e=>{ e.stopPropagation(); addToCart(btn.dataset.id); });
  });
  grid.querySelectorAll('.whatsapp-btn').forEach(btn=>{
    btn.addEventListener('click', e=> e.stopPropagation());
  });
  grid.querySelectorAll('.card').forEach(card=>{
    card.addEventListener('click', ()=>{ window.location.href = `product.html?id=${encodeURIComponent(card.dataset.id)}`; });
  });
}

function renderAll(){
  renderCategoryFilter();
  renderBrandFilter();
  renderRatingFilter();
  renderChips();
  renderProducts();
}

/* ============================================================
   CART
   ============================================================ */
function bumpCartBadge(){
  const badge = document.getElementById('cartCount');
  badge.classList.remove('bump');
  void badge.offsetWidth; // restart the animation even if it's already mid-bump
  badge.classList.add('bump');
}
function withinStock(pr, nextQty){
  return !(typeof pr?.stockQty === 'number' && pr.stockQty > 0 && nextQty > pr.stockQty);
}
function addToCart(id){
  const pr = PRODUCTS.find(p=>p.id===id);
  if(pr?.status === 'out') return;
  const nextQty = (cart[id]||0) + 1;
  if(!withinStock(pr, nextQty)) return;
  cart[id] = nextQty;
  updateCartUI();
  bumpCartBadge();
  renderProducts();
  // Adding an item shouldn't yank the shopper into the cart drawer on any
  // screen size - the badge bump is the feedback, they open it themselves
  // once they're done shopping.
}
function changeQty(id, delta){
  if(!cart[id]) return;
  if(delta > 0 && !withinStock(PRODUCTS.find(p=>p.id===id), cart[id] + delta)) return;
  cart[id] += delta;
  if(cart[id] <= 0) delete cart[id];
  updateCartUI();
  if(delta > 0) bumpCartBadge();
  renderProducts();
}
function removeFromCart(id){
  delete cart[id];
  updateCartUI();
  renderProducts();
}
let cartSyncTimer = null;
/* Best-effort mirror of a signed-in customer's cart server-side, so
   admin can follow up if they add items and leave without checking
   out. Debounced since qty +/- clicks fire this repeatedly; silently
   no-ops for guests and on any network hiccup - the real cart always
   stays in localStorage regardless. */
function syncCartToServer(){
  if(!currentCustomer) return;
  clearTimeout(cartSyncTimer);
  cartSyncTimer = setTimeout(()=>{
    const items = Object.entries(cart).map(([id, qty]) => ({ productId: id, qty }));
    fetch('/api/account/cart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    }).catch(()=>{});
  }, 800);
}

function updateCartUI(){
  localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart));
  syncCartToServer();
  const ids = Object.keys(cart);
  const totalQty = ids.reduce((s,id)=>s+cart[id],0);
  document.getElementById('cartCount').textContent = totalQty;

  const itemsWrap = document.getElementById('cartItems');
  if(!ids.length){
    itemsWrap.innerHTML = `<div class="cart-empty">
      <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>
      <p>Your cart is empty.<br>Browse the catalog to add gear.</p>
    </div>`;
    document.getElementById('cartSubtotal').textContent = fmt(0);
    return;
  }
  let subtotal = 0;
  // A cart id can outlive its product - deleted since it was added, or (while
  // the catalog failed to load just now) not fetched at all. Skip those
  // rather than crash trying to read .price off something that isn't there.
  itemsWrap.innerHTML = ids.map(id=>{
    const pr = PRODUCTS.find(x=>x.id===id);
    if(!pr) return '';
    const qty = cart[id];
    subtotal += pr.price*qty;
    const atCap = !withinStock(pr, qty + 1);
    return `<div class="cart-item">
      <div class="cart-item-media">${productImage(pr.category, pr.name, pr.image)}</div>
      <div class="cart-item-info">
        <span class="ti">${pr.name}</span>
        <span class="tb">${pr.brand}</span>
        <div class="qty-row">
          <button class="qty-btn" data-act="dec" data-id="${id}">&minus;</button>
          <span class="qty-num">${qty}</span>
          <button class="qty-btn" data-act="inc" data-id="${id}" ${atCap?'disabled':''}>+</button>
          <span class="remove-btn" data-act="rm" data-id="${id}" style="margin-left:auto;cursor:pointer;">Remove</span>
        </div>
        ${atCap ? `<span class="cart-stock-note">Max available stock reached</span>` : ''}
      </div>
      <div class="cart-item-price">${fmt(pr.price*qty)}</div>
    </div>`;
  }).join('');
  document.getElementById('cartSubtotal').textContent = fmt(subtotal);

  itemsWrap.querySelectorAll('[data-act]').forEach(el=>{
    el.addEventListener('click', ()=>{
      const id = el.dataset.id;
      if(el.dataset.act==='inc') changeQty(id,1);
      if(el.dataset.act==='dec') changeQty(id,-1);
      if(el.dataset.act==='rm') removeFromCart(id);
    });
  });
}

function openCart(){
  document.getElementById('cartDrawer').classList.add('open');
  document.getElementById('overlay').classList.add('open');
  document.body.classList.add('cart-open');
}
function closeCart(){
  document.getElementById('cartDrawer').classList.remove('open');
  document.getElementById('overlay').classList.remove('open');
  document.body.classList.remove('cart-open');
}

/* ============================================================
   EVENT WIRING
   ============================================================ */
document.getElementById('cartOpenBtn').addEventListener('click', openCart);
document.getElementById('cartCloseBtn').addEventListener('click', closeCart);
document.getElementById('overlay').addEventListener('click', ()=>{ closeCart(); closeMobileFilters(); });
document.querySelector('.checkout-btn').addEventListener('click', ()=>{
  if(Object.keys(cart).length) window.location.href = 'checkout.html';
});

document.getElementById('searchBtn').addEventListener('click', doSearch);
document.getElementById('searchInput').addEventListener('keydown', e=>{ if(e.key==='Enter') doSearch(); });
function doSearch(){
  state.search = document.getElementById('searchInput').value.trim();
  const catSel = document.getElementById('searchCategorySelect').value;
  if(catSel !== 'all') state.category = catSel;
  renderAll();
  document.getElementById('shop').scrollIntoView({behavior:'smooth'});
}

document.getElementById('sortSelect').addEventListener('change', e=>{ state.sort = e.target.value; renderProducts(); });

document.getElementById('priceMin').addEventListener('change', e=>{ state.priceMin = e.target.value ? Number(e.target.value) / USD_TO_KES : null; renderAll(); });
document.getElementById('priceMax').addEventListener('change', e=>{ state.priceMax = e.target.value ? Number(e.target.value) / USD_TO_KES : null; renderAll(); });

document.getElementById('clearFiltersBtn').addEventListener('click', ()=>{
  state.category='all'; state.brands.clear(); state.priceMin=null; state.priceMax=null; state.minRating=0; state.search='';
  document.getElementById('priceMin').value=''; document.getElementById('priceMax').value=''; document.getElementById('searchInput').value='';
  renderAll();
});

// mobile filter drawer
const filtersPanel = document.getElementById('filtersPanel');
document.getElementById('mobileFilterBtn').addEventListener('click', ()=>{
  filtersPanel.classList.add('open');
  document.getElementById('overlay').classList.add('open');
});
function closeMobileFilters(){ filtersPanel.classList.remove('open'); }

/* "All" menu quick action */
document.getElementById('allMenuBtn').addEventListener('click', ()=>{
  document.getElementById('shop').scrollIntoView({behavior:'smooth'});
});

/* ============================================================
   RECENTLY VIEWED (works for guests too — no account needed)
   ============================================================ */
function renderRecentlyViewed(){
  const strip = document.getElementById('recentStrip');
  const track = document.getElementById('recentTrack');
  if(!strip || !track) return;
  const items = getRecentlyViewedIds().map(id => PRODUCTS.find(pr => pr.id === id)).filter(Boolean);
  if(!items.length){ strip.hidden = true; return; }
  strip.hidden = false;
  track.innerHTML = items.map(pr => `
    <a class="mini-card" href="product.html?id=${encodeURIComponent(pr.id)}">
      <div class="mini-media">${productImage(pr.category, pr.name, pr.image)}</div>
      <div class="mini-brand">${pr.brand}</div>
      <div class="mini-title">${pr.name}</div>
      <div class="mini-price">${fmt(pr.price)}</div>
    </a>`).join('');
}

/* ============================================================
   ACCOUNT LABEL (shows first name in the header when signed in)
   ============================================================ */
async function updateAccountLabel(){
  const label = document.getElementById('accountLabel');
  if(!label) return;
  try {
    const response = await fetch('/api/account/me');
    if(!response.ok) return;
    const customer = await response.json();
    label.textContent = customer.name.split(' ')[0];
    currentCustomer = customer;
    if(Object.keys(cart).length){
      syncCartToServer();
    } else if(Array.isArray(customer.cart) && customer.cart.length){
      // Nothing in this device's cart yet — pick up whatever they had synced from another device.
      customer.cart.forEach(item => {
        const id = String(item.productId);
        if(PRODUCTS.some(p=>p.id===id)) cart[id] = Math.max(1, Number(item.qty)||1);
      });
      if(Object.keys(cart).length){
        updateCartUI();
        renderProducts();
      }
    }
  } catch(error) { /* stay signed out visually — not worth surfacing */ }
}

/* ============================================================
   BOOT
   ============================================================ */
/* Shown only if every retry in fetchCatalogWithRetry() failed. Replaces the
   category strip, filters and product grid with a plain "try again" state -
   never the placeholder catalog, which would otherwise look like a real,
   working shop full of products nobody can actually buy. */
function showCatalogError(){
  document.getElementById('catStrip').innerHTML = '';
  document.getElementById('mobileFilterBtn').hidden = true;
  document.getElementById('filtersPanel').hidden = true;
  document.getElementById('activeChips').innerHTML = '';
  document.querySelector('.results-bar').hidden = true;
  document.getElementById('productGrid').innerHTML = `<div class="empty-state">
    <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="13"/><circle cx="12" cy="16.5" r=".6" fill="currentColor" stroke="none"/></svg>
    <h3>Couldn&rsquo;t load the shop</h3>
    <p>Check your connection and try again.</p>
    <button class="add-btn" id="catalogRetryBtn" style="margin-top:14px;max-width:160px;">Retry</button>
  </div>`;
  document.getElementById('catalogRetryBtn').addEventListener('click', () => window.location.reload());
}

async function bootStorefront(){
  renderSkeletonGrid();
  try {
    await loadStorefrontCatalog();
    initStaticUI();
    renderAll();
  } catch(error) {
    console.error(error);
    CATEGORIES = [];
    BRANDS_BY_CAT = {};
    PRODUCTS = [];
    showCatalogError();
  }
  updateCartUI();
  renderRecentlyViewed();
  updateAccountLabel();
}

bootStorefront();
