/* ============================================================
  SHARED CATALOG HELPERS — used by the storefront (app.js) and the
  product detail page (product.js). Kept in one place so the image
  placeholder, price formatting and storage keys stay consistent
  everywhere.

  Deliberately category-agnostic: the catalog's categories come from
  your database, so nothing here assumes what you sell.
   ============================================================ */

/* Shown wherever a product has no image of its own. A neutral outline
   rather than a stock photo, so an empty slot never looks like real
   product photography. */
const PLACEHOLDER_ICON = `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M8 22l24-12 24 12v20L32 54 8 42V22Z"/><path d="M8 22l24 12 24-12"/><path d="M32 34v20"/></svg>`;

/* Up to 3 images for a product, in upload order. Empty when the
   product has none, which the gallery renders as the placeholder. */
function imagesForProduct(product){
  return [product.image, product.image2, product.image3].filter(Boolean).slice(0, 3);
}

/* Category names are free text in the admin dashboard, so the
   storefront needs a stable id it can put in URLs, filters and data
   attributes: "Men's Shoes" -> "mens-shoes". */
function storefrontCategoryId(name){
  return String(name || 'other')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'other';
}

/* Currency comes from store.config.js (served as /store-config.js),
   with a plain fallback in case this file is ever used on its own. */
function storeCurrency(){
  return (window.STORE_CONFIG && window.STORE_CONFIG.currency) || { symbol: '$', code: 'USD', locale: 'en-US' };
}

function fmt(n){
  const currency = storeCurrency();
  const symbol = currency.symbol || '';
  const amount = Math.round(Number(n || 0)).toLocaleString(currency.locale || 'en-US');
  // "$1,234" reads right for single-character symbols, "CHF 1,234" for words.
  return symbol.length > 1 ? `${symbol} ${amount}` : `${symbol}${amount}`;
}

function starsSVG(rating, size=14){
  let out = '';
  for(let i=1;i<=5;i++){
    const fill = rating >= i ? 'currentColor' : (rating >= i-0.5 ? 'url(#half)' : 'none');
    out += `<svg width="${size}" height="${size}" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" fill="${fill}"><polygon points="12 2 15 9 22 9.5 17 14.5 18.5 22 12 18 5.5 22 7 14.5 2 9.5 9 9"/></svg>`;
  }
  return out;
}

/* One <img> plus a hidden placeholder that takes over if the file is
   missing or fails to load. With no image at all, only the
   placeholder is rendered. */
function productImage(_category, alt, src){
  if(!src) return `<span class="image-fallback">${PLACEHOLDER_ICON}</span>`;
  return `<img src="${src}" alt="${alt}" loading="lazy" onerror="this.hidden=true;this.nextElementSibling.hidden=false;"><span class="image-fallback" hidden>${PLACEHOLDER_ICON}</span>`;
}

const WHATSAPP_ICON_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 3.5A11.85 11.85 0 0 0 12.08 0C5.53 0 .2 5.33.2 11.88c0 2.1.55 4.15 1.6 5.96L.1 24l6.3-1.65a11.86 11.86 0 0 0 5.68 1.45h.01c6.55 0 11.88-5.33 11.88-11.88 0-3.17-1.23-6.15-3.47-8.42ZM12.09 21.8h-.01a9.86 9.86 0 0 1-5.02-1.37l-.36-.21-3.74.98 1-3.64-.23-.37a9.86 9.86 0 1 1 8.36 4.61Zm5.41-7.39c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.17-.17.2-.35.22-.65.07-.3-.15-1.25-.46-2.38-1.47-.88-.79-1.47-1.76-1.64-2.06-.17-.3-.02-.46.13-.61.14-.14.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.07-.15-.67-1.62-.92-2.22-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.79.37-.27.3-1.04 1.02-1.04 2.49s1.07 2.89 1.22 3.09c.15.2 2.1 3.2 5.08 4.49.71.31 1.27.49 1.7.63.71.23 1.36.2 1.87.12.57-.08 1.76-.72 2.01-1.42.25-.7.25-1.3.17-1.42-.07-.12-.27-.2-.57-.35Z"/></svg>`;

/* wa.me deep link pre-filled with an order enquiry, so shoppers can
   order over WhatsApp. Returns '' when no WhatsApp number is
   configured, and callers then leave the button out entirely. */
function whatsappOrderUrl(productName){
  if(typeof window.storeWhatsappUrl !== 'function') return '';
  return window.storeWhatsappUrl(`Hello, I'm interested in this ${productName}`);
}

const CART_STORAGE_KEY = 'store_cart';

/* Lets a guest (no account needed) pick up where they left off:
   cart already persists via CART_STORAGE_KEY above, and this does the
   same for the last few products they looked at. */
const RECENTLY_VIEWED_KEY = 'store_recently_viewed';
const RECENTLY_VIEWED_MAX = 10;

function recordRecentlyViewed(productId){
  const id = String(productId);
  let ids = getRecentlyViewedIds();
  ids = [id, ...ids.filter(existing => existing !== id)].slice(0, RECENTLY_VIEWED_MAX);
  localStorage.setItem(RECENTLY_VIEWED_KEY, JSON.stringify(ids));
}

function getRecentlyViewedIds(){
  try { return JSON.parse(localStorage.getItem(RECENTLY_VIEWED_KEY) || '[]'); } catch(error){ return []; }
}
