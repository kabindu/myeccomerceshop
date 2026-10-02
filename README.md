# My Store

A self-hosted online store you can download, point at your own database, and put your own name on.

Storefront, customer accounts, a seller marketplace and an admin dashboard. Plain HTML, CSS and JavaScript on the front, Node.js and PostgreSQL on the back — no build step, no framework.

---

## Setup

Needs **Node.js 18+** and a **PostgreSQL database** (local, or a free one from Neon or Supabase).

```bash
git clone <your-repo-url> my-store
cd my-store
npm install
cp .env.example .env
```

Open `.env` and fill in four values:

```ini
DATABASE_URL=postgres://user:password@host:5432/mystore
ADMIN_USERNAME=you
ADMIN_PASSWORD=a-long-random-password
SESSION_SECRET=another-long-random-string
```

Then:

```bash
npm start
```

That's it — the database tables are created on first start. Open **http://localhost:3000**.

| Page | What it is |
| --- | --- |
| `/` | The storefront |
| `/admin` | Your dashboard — sign in with `ADMIN_USERNAME` / `ADMIN_PASSWORD` |
| `/seller/login.html` | Where sellers apply and sign in |
| `/account.html` | Where customers sign in |

**To add products**, go to `/admin` and create a **category**, then a **brand**, then your products. They appear on the storefront straight away.

---

## Make it yours

Everything about your shop's identity lives in one file, [store.config.js](store.config.js):

| Setting | Changes |
| --- | --- |
| `name`, `tagline`, `description` | Header, page titles, footer |
| `logo` | Your logo — replace `images/logo.svg` or point elsewhere |
| `currency` | `$1,234`, `KSh 1,234`, `€1.234` — code, symbol and locale |
| `contact` | WhatsApp, phone, email, address |
| `social` | Footer and floating social links |
| `mapQuery` | Address for the footer map |
| `paymentNote`, `shippingNote`, `returnsNote` | What shoppers are told |

**Anything you leave empty disappears from the page** — no WhatsApp number means no WhatsApp buttons, no `mapQuery` means no map.

Colours are CSS variables at the top of [css/styles.css](css/styles.css) (storefront) and [css/dashboard/](css/dashboard/) (dashboards).

---

## Orders and payment

**No payment gateway is built in; nothing is charged online.** Checkout re-prices the cart on the server, records the order as `pending` and empties the cart. You take payment your own way — cash on delivery, transfer, a payment link — and mark the order **paid** in `/admin`. Stock comes off sale when an order is placed and goes back if you cancel it.

To add a gateway, charge the customer inside `POST /api/orders` in [server.js](server.js) and create the order as `paid`. The browser never sends an amount, so a gateway added there can't be tricked by a tampered cart.

---

## Sellers

Sellers apply, then you approve them in `/admin` (`pending` → `active`). Approved sellers manage only their own products.

Two optional extras, both off until you add credentials:

**Sign in with Google.** In the [Google Cloud console](https://console.cloud.google.com): **Credentials → Create credentials → OAuth client ID → Web application**, and add this redirect URI exactly:

```
http://localhost:3000/api/seller/auth/google/callback
https://your-domain.com/api/seller/auth/google/callback
```

Put the client ID and secret in `.env` as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`. The button only appears once they're set.

**Emailed verification codes.** Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and `MAIL_FROM` in `.env` — any SMTP provider works. Codes are 6 digits, valid 10 minutes, 5 tries, one send a minute. **Without SMTP, codes print to the server console** so you can test locally; they are never returned in an HTTP response.

Verification is separate from your approval: a verified seller still waits for you, and you can approve one who never verified. The admin Sellers table shows both.

---

## Deploying

Any Node host:

```bash
npm install --omit=dev
npm start
```

Set the same variables you put in `.env` — the file itself is never deployed. Product images are written to `uploads/`, so give it persistent storage.

**On Vercel**, [vercel.json](vercel.json) routes everything through `server.js`. Serverless filesystems get wiped, so add a `BLOB_READ_WRITE_TOKEN` and uploads go to Vercel Blob instead.

---

## What's inside

```
store.config.js   Your branding            server.js   API, auth, orders, schema
.env.example      Every available key      mailer.js   SMTP for seller codes
schema.sql        Database reference

index.html  product.html  checkout.html  account.html    admin/   seller/

js/   branding.js      applies store.config.js everywhere
      app.js           catalog, filters, cart
      seller-auth.js   seller sign-in, Google, email codes
      checkout.js  product.js  account.js  catalog-shared.js

css/  styles.css       storefront
      dashboard/       admin + seller (one shared source)
```

Maintenance scripts:

```bash
node scripts/generate-thumbnails.js                  # WebP thumbnails, safe to re-run
node scripts/migrate-images-to-files.js --dry-run    # only if you imported base64 images
```

<details>
<summary><strong>API reference</strong></summary>

Public:
- `GET /api/catalog/light`, `/api/taxonomy`, `/api/products/:id`
- `POST /api/products/:id/rate`, `POST /api/orders`
- `GET /store-config.js`

Customers:
- `POST /api/account/register`, `/login`, `/logout`
- `GET /api/account/me`, `/api/account/orders`, `POST /api/account/cart`

Sellers (public sign-up):
- `POST /api/seller/register`, `/login`, `/logout`
- `GET /api/seller/auth/google`, `/callback`, `/pending`, `POST /api/seller/register/google`
- `POST /api/seller/otp/send`, `/api/seller/otp/verify`

Sellers (signed in):
- `GET /api/seller/me`, full CRUD on `/api/seller/products`

Admin (everything else under `/api`):
- `/api/products`, `/api/categories`, `/api/brands`
- `/api/catalog`, `/api/customers`, `GET /api/orders`, `PUT /api/orders/:id/status`
- `/api/sellers`, `PUT /api/sellers/:id/status`

</details>

---

## Good to know

- There is no default admin account. Until `ADMIN_USERNAME` and `ADMIN_PASSWORD` are set, `/admin` cannot be signed into at all.
- Without `SESSION_SECRET` the server invents a temporary one, so everyone is signed out on each restart.
- Customer accounts are deliberately light: no email verification, no password reset.
- A seller who signs up with Google has no password and keeps using the Google button. Using Google on an address that already has a password links the two.
- Ratings are one per browser, kept in `localStorage`.
- `images/logo.svg` is a placeholder — replace it.
