/* ============================================================
   PRODUCT DETAIL PAGE — image gallery (up to 3 images) + full
   description. Shares the placeholder and price formatting with the
   storefront via js/catalog-shared.js.
   ============================================================ */
let product = null;
let galleryImages = [];
let activeImageIndex = 0;
let qty = 1;

const cart = JSON.parse(localStorage.getItem(CART_STORAGE_KEY) || '{}');

function saveCart(){
  localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart));
  document.getElementById('cartCount').textContent = Object.values(cart).reduce((s,q)=>s+q,0);
}

function renderGallery(){
  const media = document.getElementById('pdMainMedia');
  const existingArrows = media.querySelectorAll('.pd-nav-arrow');
  media.querySelectorAll('img, .image-fallback').forEach(el=>el.remove());
  media.insertAdjacentHTML('afterbegin', productImage(product.category, product.name, galleryImages[activeImageIndex]));
  existingArrows.forEach(arrow => arrow.hidden = galleryImages.length < 2);

  document.getElementById('pdThumbs').innerHTML = galleryImages.length < 2 ? '' : galleryImages.map((src,i)=>`
    <button class="pd-thumb ${i===activeImageIndex?'active':''}" data-i="${i}">
      <img src="${src}" alt="${product.name} view ${i+1}" onerror="this.style.display='none'">
    </button>`).join('');
  document.querySelectorAll('.pd-thumb').forEach(btn=>{
    btn.addEventListener('click', ()=>{ activeImageIndex = Number(btn.dataset.i); renderGallery(); });
  });
}

function goToImage(delta){
  activeImageIndex = (activeImageIndex + delta + galleryImages.length) % galleryImages.length;
  renderGallery();
}

function updateRatingDisplay(){
  document.getElementById('pdRating').innerHTML = `<span class="stars">${starsSVG(product.rating || 0, 16)}</span> <span>${product.rating || 0}</span> <span style="color:var(--text-faint)">(${product.reviews || 0} reviews)</span>`;
}

function renderRateWidget(){
  const key = `store_rated_${product.id}`;
  const already = localStorage.getItem(key);
  const starsWrap = document.getElementById('pdRateStars');
  const note = document.getElementById('pdRateNote');
  if(already){
    starsWrap.innerHTML = '';
    note.hidden = false;
    note.textContent = `You rated this ${already}★. Thanks!`;
    return;
  }
  note.hidden = true;
  starsWrap.innerHTML = [1,2,3,4,5].map(n => `<button type="button" class="pd-rate-star" data-n="${n}" aria-label="Rate ${n} star${n>1?'s':''}">★</button>`).join('');
  const starButtons = [...starsWrap.querySelectorAll('.pd-rate-star')];
  const highlight = n => starButtons.forEach(btn => btn.classList.toggle('active', Number(btn.dataset.n) <= n));
  starButtons.forEach(btn => {
    btn.addEventListener('mouseenter', () => highlight(Number(btn.dataset.n)));
    btn.addEventListener('click', () => submitRating(Number(btn.dataset.n)));
  });
  starsWrap.addEventListener('mouseleave', () => highlight(0));
}

async function submitRating(score){
  try {
    const response = await fetch(`/api/products/${product.id}/rate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating: score }),
    });
    const data = await response.json();
    if(!response.ok) throw new Error(data.error || 'Could not save your rating.');
    localStorage.setItem(`store_rated_${product.id}`, String(score));
    product.rating = data.rating;
    product.reviews = data.reviews;
    updateRatingDisplay();
    renderRateWidget();
  } catch(error){
    alert(error.message);
  }
}

function renderProduct(){
  const discount = product.originalPrice ? Math.round(100 * (1 - product.price / product.originalPrice)) : null;
  document.title = `${product.name} — ${(window.STORE_CONFIG && window.STORE_CONFIG.name) || 'Store'}`;
  document.getElementById('pdCrumb').innerHTML = `<a href="index.html">Shop</a> &rsaquo; <span>${product.category_name || product.category}</span> &rsaquo; <span>${product.name}</span>`;
  document.getElementById('pdBrand').textContent = product.brand;
  document.getElementById('pdTitle').textContent = product.name;
  updateRatingDisplay();
  renderRateWidget();
  document.getElementById('pdPriceRow').innerHTML = `
    <span class="pd-price">${fmt(product.price)}</span>
    ${product.originalPrice ? `<span class="pd-price-old">${fmt(product.originalPrice)}</span>` : ''}
    ${discount ? `<span class="pd-discount-tag">-${discount}%</span>` : ''}
  `;
  document.getElementById('pdSpec').textContent = product.spec || '';
  document.getElementById('pdSpec').hidden = !product.spec;
  const stockOut = product.status === 'out';
  document.getElementById('pdStock').innerHTML = stockOut
    ? `<span class="card-stock low">Out of stock</span>`
    : `<span class="card-stock">In stock</span>`;
  document.getElementById('pdAddBtn').disabled = stockOut;
  document.getElementById('pdMobileAddBtn').disabled = stockOut;
  document.getElementById('pdMobilePrice').textContent = fmt(product.price);
  document.getElementById('pdDescription').innerHTML = (product.description || 'No description provided for this product yet.')
    .split(/\n+/).filter(Boolean).map(paragraph => `<p>${paragraph}</p>`).join('');

  const quoteBtn = document.getElementById('pdQuoteBtn');
  const quoteUrl = whatsappOrderUrl(product.name);
  if(quoteUrl) quoteBtn.href = quoteUrl;
  else quoteBtn.remove();

  galleryImages = imagesForProduct(product);
  activeImageIndex = 0;
  renderGallery();
}

function setQty(next){
  qty = Math.max(1, next);
  document.getElementById('pdQtyNum').textContent = qty;
}

function flashAdded(){
  const note = document.getElementById('pdAddedNote');
  note.hidden = false;
  clearTimeout(flashAdded._t);
  flashAdded._t = setTimeout(()=> note.hidden = true, 2200);
}

function addCurrentToCart(){
  cart[product.id] = (cart[product.id] || 0) + qty;
  saveCart();
  flashAdded();
}

async function boot(){
  const id = new URLSearchParams(window.location.search).get('id');
  saveCart();
  try {
    const response = await fetch(`/api/products/${encodeURIComponent(id)}`);
    if(response.ok){
      const found = await response.json();
      const category = storefrontCategoryId(found.category);
      product = {
        id: found.id,
        name: found.name,
        brand: found.brand,
        category,
        category_name: found.category,
        price: Number(found.price),
        originalPrice: found.originalPrice ? Number(found.originalPrice) : null,
        spec: found.spec || '',
        description: found.description || '',
        status: found.status,
        rating: Number(found.rating) || 0,
        reviews: Number(found.reviews) || 0,
        image: found.image,
        image2: found.image2,
        image3: found.image3,
      };
    }
  } catch(error){
    console.error(error);
  }

  if(!product){
    document.getElementById('pdNotFound').hidden = false;
    return;
  }

  document.getElementById('pdWrap').hidden = false;
  document.getElementById('pdMobileBar').hidden = false;
  recordRecentlyViewed(product.id);
  renderProduct();

  document.getElementById('pdPrev').addEventListener('click', ()=> goToImage(-1));
  document.getElementById('pdNext').addEventListener('click', ()=> goToImage(1));
  document.getElementById('pdQtyDec').addEventListener('click', ()=> setQty(qty - 1));
  document.getElementById('pdQtyInc').addEventListener('click', ()=> setQty(qty + 1));
  document.getElementById('pdAddBtn').addEventListener('click', addCurrentToCart);
  document.getElementById('pdMobileAddBtn').addEventListener('click', addCurrentToCart);

  let touchStartX = null;
  const media = document.getElementById('pdMainMedia');
  media.addEventListener('touchstart', e => { touchStartX = e.touches[0].clientX; }, { passive: true });
  media.addEventListener('touchend', e => {
    if(touchStartX == null || galleryImages.length < 2) return;
    const delta = e.changedTouches[0].clientX - touchStartX;
    if(Math.abs(delta) > 40) goToImage(delta < 0 ? 1 : -1);
    touchStartX = null;
  });
}

boot();
