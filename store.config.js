/* ============================================================
   STORE CONFIGURATION — edit this file to make the shop yours.

   Nothing here is secret, so it is safe to commit. Passwords,
   database URLs and payment keys all live in .env instead
   (copy .env.example to get started).

   Every value can also be set with an environment variable, which
   is handy on hosts where you would rather not edit files. The
   environment variable always wins over the default written here.
   ============================================================ */
module.exports = {
  // Shown in the header, page titles, emails and payment references.
  name: process.env.STORE_NAME || 'My Store',

  // One short line under the logo.
  tagline: process.env.STORE_TAGLINE || 'Online Store',

  // Used in the footer blurb and as the page meta description.
  description: process.env.STORE_DESCRIPTION || 'Browse the catalog, add to cart and check out online.',

  // Path or full URL to your logo. Replace images/logo.svg with your
  // own file, or point this at any image you host.
  logo: process.env.STORE_LOGO || '/images/logo.svg',

  // How prices are displayed. `code` is what shows on the price
  // filter, `symbol` prefixes every amount, and `locale` controls
  // digit grouping (e.g. 1,234 vs 1.234).
  currency: {
    code: process.env.STORE_CURRENCY_CODE || 'USD',
    symbol: process.env.STORE_CURRENCY_SYMBOL || '$',
    locale: process.env.STORE_LOCALE || 'en-US',
  },

  // Leave any of these empty and the matching link or section is
  // simply not rendered — no dead links, no placeholder text.
  contact: {
    // Digits only, including the country code: 15551234567
    whatsapp: process.env.STORE_WHATSAPP || '',
    phone: process.env.STORE_PHONE || '',
    email: process.env.STORE_EMAIL || '',
    address: process.env.STORE_ADDRESS || '',
  },

  // Full profile URLs. Empty ones are hidden.
  social: {
    instagram: process.env.STORE_INSTAGRAM || '',
    facebook: process.env.STORE_FACEBOOK || '',
    tiktok: process.env.STORE_TIKTOK || '',
    x: process.env.STORE_X || '',
    youtube: process.env.STORE_YOUTUBE || '',
  },

  // Anything Google Maps can search — an address, a place name or
  // "lat,lng". Empty hides the map in the footer.
  mapQuery: process.env.STORE_MAP_QUERY || '',

  // Footer "Visit us" / shipping copy.
  shippingNote: process.env.STORE_SHIPPING_NOTE || 'Delivery options and costs are confirmed at checkout.',

  // Returns policy line used in the storefront help panel.
  returnsNote: process.env.STORE_RETURNS_NOTE || 'Contact us within 30 days if something is not right.',

  // How customers pay. There is no payment gateway built in: orders are
  // recorded and you settle them yourself, so say here what a shopper
  // should expect (bank transfer, cash on delivery, a payment link...).
  paymentNote: process.env.STORE_PAYMENT_NOTE || 'Place your order online and we will contact you to arrange payment.',
};
