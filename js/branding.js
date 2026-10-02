/* ============================================================
   BRANDING — applies store.config.js to every page.

   The server serves the config as /store-config.js, which defines
   window.STORE_CONFIG before this file runs. Pages therefore ship
   with neutral placeholder text and mark the spots to fill in with
   data attributes, so there is only ever one place to edit a store
   name, a phone number or a currency:

     data-store="name|tagline|description|address|phone|email|
                 currencyCode|year|brand|shippingNote|returnsNote|
                 paymentNote"
     data-store-logo                  img -> config.logo
     data-store-link="whatsapp|instagram|facebook|tiktok|x|youtube|
                      phone|email"
     data-store-map                   google maps embed, or removed

   Anything pointing at a value the owner left empty is removed from
   the page rather than left as a dead link.
   ============================================================ */
(function () {
  const config = window.STORE_CONFIG || {};
  const contact = config.contact || {};
  const social = config.social || {};
  const currency = config.currency || {};
  const storeName = config.name || 'My Store';

  /* Page titles are set from the <meta name="store-page-title"> each
     page declares, so the store name only has to be configured once.
     Done outside DOMContentLoaded so the tab never flashes a
     placeholder name. */
  const pageTitleMeta = document.querySelector('meta[name="store-page-title"]');
  const pageTitle = pageTitleMeta ? pageTitleMeta.content.trim() : '';
  if (pageTitle) document.title = `${pageTitle} — ${storeName}`;
  else document.title = config.tagline ? `${storeName} — ${config.tagline}` : storeName;

  function whatsappUrl(message) {
    if (!contact.whatsapp) return '';
    const digits = String(contact.whatsapp).replace(/[^0-9]/g, '');
    if (!digits) return '';
    return `https://wa.me/${digits}${message ? `?text=${encodeURIComponent(message)}` : ''}`;
  }

  // Exposed so the storefront can offer "order on WhatsApp" per product.
  window.storeWhatsappUrl = whatsappUrl;

  const TEXT_VALUES = {
    name: storeName,
    tagline: config.tagline || '',
    description: config.description || '',
    address: contact.address || '',
    phone: contact.phone || '',
    email: contact.email || '',
    currencyCode: currency.code || '',
    shippingNote: config.shippingNote || '',
    returnsNote: config.returnsNote || '',
    paymentNote: config.paymentNote || '',
    year: String(new Date().getFullYear()),
  };

  const LINK_VALUES = {
    whatsapp: whatsappUrl(''),
    instagram: social.instagram || '',
    facebook: social.facebook || '',
    tiktok: social.tiktok || '',
    x: social.x || '',
    youtube: social.youtube || '',
    phone: contact.phone ? `tel:${String(contact.phone).replace(/\s+/g, '')}` : '',
    email: contact.email ? `mailto:${contact.email}` : '',
  };

  /* Keeps the two-tone logo wordmark working for any store name:
     first word plain, the rest in a <span> the stylesheet colors. */
  function renderBrand(element) {
    const parts = storeName.split(' ');
    element.textContent = parts[0];
    if (parts.length > 1) {
      const rest = document.createElement('span');
      rest.textContent = ` ${parts.slice(1).join(' ')}`;
      element.appendChild(rest);
    }
  }

  function apply() {
    document.querySelectorAll('[data-store]').forEach(element => {
      const key = element.dataset.store;
      if (key === 'brand') return renderBrand(element);
      const value = TEXT_VALUES[key];
      if (value === undefined) return;
      // An element whose only job is to show a value the owner left
      // blank (an address block, a phone line) should disappear.
      if (!value && element.hasAttribute('data-store-optional')) return element.remove();
      element.textContent = value;
    });

    document.querySelectorAll('[data-store-logo]').forEach(image => {
      image.src = config.logo || '/images/logo.svg';
      image.alt = `${storeName} logo`;
    });

    document.querySelectorAll('[data-store-link]').forEach(link => {
      const url = LINK_VALUES[link.dataset.storeLink];
      if (!url) return link.remove();
      const message = link.dataset.storeMessage;
      link.href = message && link.dataset.storeLink === 'whatsapp' ? whatsappUrl(message) : url;
    });

    document.querySelectorAll('[data-store-map]').forEach(container => {
      if (!config.mapQuery) return container.remove();
      const frame = document.createElement('iframe');
      frame.src = `https://maps.google.com/maps?q=${encodeURIComponent(config.mapQuery)}&output=embed`;
      frame.width = '100%';
      frame.height = '140';
      frame.loading = 'lazy';
      frame.referrerPolicy = 'no-referrer-when-downgrade';
      frame.title = `${storeName} location`;
      frame.style.border = '0';
      container.appendChild(frame);
    });

    const metaDescription = document.querySelector('meta[name="description"]');
    if (metaDescription && config.description) metaDescription.content = config.description;

    // A socials rail with every link removed leaves an empty floating
    // container, so drop the wrapper too.
    document.querySelectorAll('[data-store-social-rail]').forEach(rail => {
      if (!rail.querySelector('a')) rail.remove();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply);
  else apply();
})();
