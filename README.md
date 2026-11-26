# Smart POS

A React + TypeScript retail operations application with an Express API and MySQL persistence. The current foundation includes authenticated, role-gated access; branch-scoped staff management; an editable product catalogue; inventory adjustments, expiry batches, physical stock counts, and inter-branch transfers; supplier and purchase-order workflows; customer records; cashier shifts and cash movements; expense submissions and approvals; sales history and cash refunds; transactional cash, verified bank-transfer, cash/bank split, and configuration-gated Daraja M-Pesa checkout; and branch-scoped reports with CSV export.

## Requirements

- Node.js 20+
- MySQL 8+

## Local setup

1. Copy `.env.example` to `.env` and set a strong `JWT_SECRET`, MySQL connection, and initial admin credentials.
2. Create the configured MySQL database and user.
3. Run `npm install`.
4. Run `npm run db:migrate` and `npm run db:seed`.
5. Run `npm run dev`. The web app is at `http://localhost:5173`; the API listens on port 4000.

## Render deployment

The root `render.yaml` defines one Render web service. It builds the client and API together, serves the client and `/api` from the same HTTPS origin, and applies database migrations before starting the API. Render supplies `PORT` and `JWT_SECRET`; set `DATABASE_URL` in the Render dashboard.

This application requires MySQL 8. Render does not provide a managed MySQL service, so attach a separately hosted MySQL 8 database that accepts connections from Render. Do not use a laptop's `localhost` or private-LAN database address. If you want to keep current business data, back it up and import it into the hosted database before pointing the app at it; deployment does not copy local data.

To create the first administrator in a brand-new, empty database, temporarily set `SEED_ADMIN_EMAIL`, a strong `SEED_ADMIN_PASSWORD`, and `SEED_SAMPLE_PRODUCTS=false` in the Render environment, then run `npm run db:seed` from the Render Shell. This creates the initial branch and administrator without adding demo products. Remove those temporary variables after seeding. Do not run the seed against an existing production database unless you intend to grant the specified account administrator access.

The Blueprint uses Render's free web-service plan, which can sleep when idle and is not appropriate for uninterrupted shop operations. Choose an always-on plan in Render for production use. Configure `CLIENT_ORIGIN` to your exact HTTPS custom-domain origin if you add one. Payment, WhatsApp, and backup integrations also need their server-side credentials/configuration; backup storage must be durable and separate from the live database, not the web service's ephemeral filesystem.

## Railway deployment

Create a Railway project with a MySQL service and a web service connected to this repository. Keep the web service at the repository root. In its settings, configure:

- Build command: `npm run build`
- Pre-deploy command: `npm run db:migrate:prod --workspace server`
- Start command: `npm run start`
- Health check path: `/api/health`

In the web service variables, set `NODE_ENV=production`, `DATABASE_URL=${{ mysql.MYSQL_URL }}` (replace `mysql` with the exact MySQL service name), and a unique `JWT_SECRET` of at least 32 characters. Railway supplies `PORT`; the server automatically trusts the generated `RAILWAY_PUBLIC_DOMAIN`. Generate a public domain for the web service. If using a custom domain, set `CLIENT_ORIGIN` to its exact HTTPS origin.

Railpack installs dependencies for the root npm workspace before running the build command. Do not add `npm ci` or `npm install` to the Railway build command: reinstalling can remove `client/node_modules/.vite` while Vite is building. The client’s `vite`, TypeScript, React, and Tailwind build plugins are declared in `client/package.json` and included by the root lockfile. The root `npm run build` compiles the API and then runs the client production build into `client/dist`, which the server serves in production.

For a brand-new, empty database only, temporarily set `SEED_ADMIN_EMAIL`, a strong `SEED_ADMIN_PASSWORD`, and `SEED_SAMPLE_PRODUCTS=false` on the web service, then run `node server/dist/seed.js` once from the Railway service shell. Remove the temporary seed variables after creating the administrator. Do not seed an existing database; a new Railway MySQL service does not contain existing local business data.

Run the app on a persistent Railway plan for shop operations, and configure database backups before using real transactions. If enabling Daraja M-Pesa, set its callback URL to the generated HTTPS domain ending in `/api/mpesa/callback`.

### Automatic receipt printing (Windows kiosk)

After a sale completes, the POS opens the receipt and calls the browser print API. In a normal browser this displays a print dialog. For unattended printing, set the receipt printer as the Windows default printer, install its driver, and launch the POS in Edge or Chrome kiosk printing mode:

```powershell
.\scripts\start-pos-kiosk.ps1 -Url "https://your-pos-host/pos" -Browser Edge
```

Use `-Browser Chrome` to select Chrome. The launcher enables kiosk printing and uses a separate persistent browser profile; print jobs go directly to the Windows default printer without a confirmation dialog. Test the printer and paper size before cashier use. This requires the kiosk browser to run on the cashier computer; a remotely hosted web server cannot access that computer's printer directly.

### Android phone barcode scanner

From POS, select **Phone scanner**; from an Add Product form, select **Connect Phone Scanner**. Each flow creates a one-time QR code. On Android Chrome, scan it to open `/mobile-scanner`, grant camera access, and use the rear camera (EAN-13, EAN-8, UPC-A, UPC-E, and Code 128). Manual barcode entry, connection status, reconnect, and disconnect controls are available on the phone. The laptop also shows whether the phone is connected and can revoke its pairing.

POS-mode scans use exact local barcode lookup for the active cashier's branch and add/increment cart items; checkout is still required to complete the sale and deduct stock. Product-registration scans are delivered to the open Add Product form, checked for local duplicates, and then looked up against Open Food Facts only for supported EAN/UPC codes. Review the retrieved data and enter prices and opening stock before saving.

For remote use across different networks, deploy the frontend and API at publicly reachable HTTPS origins and configure:

- `CLIENT_ORIGIN` to the exact frontend origin (scheme and host, plus port if nonstandard), allowing the browser's credentialed API requests.
- `VITE_API_BASE_URL` to the deployed API base URL, including `/api`.
- `VITE_PUBLIC_APP_URL` to the frontend HTTPS origin embedded in the pairing QR code.

These `VITE_*` values are read at frontend build time. Rebuild the client after changing them. Both the laptop browser and phone must reach the same public HTTPS frontend/API and shared MySQL database; the short-lived QR link uses `VITE_PUBLIC_APP_URL`, and `VITE_API_BASE_URL` points the phone and laptop frontend to the same API. The service uses authenticated HTTPS polling with pairing tokens and scanner bearer tokens (no raw database credentials are sent to the phone). Android camera access requires a trusted HTTPS context.

If the database/API run only on the laptop, a phone on a different network cannot reach `localhost` or a private LAN address. Use a securely configured HTTPS reverse proxy or managed tunnel for the web app/API, set the origin/API variables above, and restrict access with application authentication; never expose the MySQL port or development server directly to the internet. Alternatively deploy the app/API/database to a reachable host. For local testing, use a phone-reachable hostname with a trusted certificate; a self-signed development certificate may not be trusted by Android Chrome.

Apply migrations `015_mobile_scanner.sql` and `018_mobile_registration_scanner.sql` before deploying scanner pairing. Pairing tokens are single-use and expire after 90 seconds; scanner bearer tokens are stored only as hashes and are bound to either the active POS session or authenticated product-registration session. Pending scans and pairing state are stored in MySQL, so they survive API restarts and can be shared by multiple API instances. The phone and laptop exchange status and queued scans using authenticated HTTPS polling (not WebSockets); the laptop polls approximately every 1.2 seconds. Pair again if the short-lived QR expires. Verify deployed HTTPS origins, CORS configuration, migration, reverse-proxy/tunnel controls, and Android camera access before relying on remote scanning.

### Two-stage product barcode identification

In Products, **Scan** opens an in-page camera scanner for EAN-13, EAN-8, UPC-A, UPC-E, and Code 128. Before any internet request, the API checks the existing product table for the exact barcode; an existing active or archived product is reported as a duplicate and is not sent to an external catalogue. Unregistered numeric EAN/UPC barcodes are looked up in Open Food Facts; other barcode formats are retained for manual registration without an unsupported online request. Returned name, generic description, brand, category, package size, and allowlisted product image are used only when the catalogue actually provides them. Staff can edit the retrieved fields, enter details manually when there is no match or the API is unavailable, or generate an internal-use EAN-13 with the restricted-circulation `20` prefix. Database uniqueness constraints remain the final protection against duplicate SKUs and barcodes. Imported images are downloaded by the API only from Open Food Facts image hosts, validated, limited to 5 MB, and stored using the existing product-image storage.

At POS checkout, USB/keyboard-emulating scanners and paired phone scanners resolve barcodes against the local branch inventory only. Unknown scanned barcodes display “Product not found in inventory. Contact administrator.” The cashier cannot register products from checkout; scanning only adds or increments a cart item and does not complete a sale or deduct stock. Ordinary typed product search remains available.

Run `npm run db:migrate` to apply migrations `016_product_lookup_fields.sql` and `017_product_description.sql` before deploying these fields. They are additive and preserve existing catalogue data. Registration lookup requires outbound HTTPS access from the API to `world.openfoodfacts.org`; checkout does not make an external request. Open Food Facts coverage is incomplete, so verify returned values before saving. The scanner uses the existing ZXing library and requires a trusted HTTPS browser context for camera access.

The seed command refuses to run without an explicitly configured admin password. Keep `.env` private.

## API

The API is served under `/api`. Authentication, staff, dashboard, reports, catalogue, checkout, inventory, supplier, purchase order, customer, shift, expense, and refund endpoints are documented in [docs/API.md](./docs/API.md).

All monetary values are stored as MySQL `DECIMAL`. The sale API computes prices and totals from the database, locks inventory rows, rejects insufficient stock by default, and commits sale, payments, stock movements, and audit data in one transaction. Cash and administrator-verified bank transfers are supported, including cash/bank split tender. Daraja M-Pesa STK Push is implemented server-side but remains unavailable until credentials and a publicly reachable HTTPS callback URL are configured. Card terminal references are recorded after cashier confirmation; the POS does not independently verify them with a card provider. Run `npm run db:migrate` to apply `server/migrations/019_mpesa_payment_requests.sql` before enabling M-Pesa. Do not treat initiated or unconfirmed external payments as paid.

## Project layout

- `client/` — React, Vite, Tailwind CSS, React Router, TanStack Query.
- `server/` — Express API, validation, authentication, and MySQL services.
- `server/migrations/` — versioned SQL migrations.

## Current scope and remaining work

The operations listed above have application screens and API workflows. Product archival is blocked while any branch has on-hand/reserved inventory or an open purchase order. Receiving can record batch codes and expiry dates; checkout consumes unexpired lots by earliest expiry, and expired quantities are excluded from saleable stock. Stock counts snapshot active products and reconcile variances through the inventory and batch ledgers. Inter-branch transfers move quantity and lot metadata on dispatch, then reconcile received quantities and shortages at the destination. Reports cover sales trends, cashiers, products, categories, payment mix, expenses, purchasing, inventory valuation, and low stock; CSV export is provided. Gross and net profit are suppressed when cost snapshots are incomplete. This is still an incremental foundation, not a claim that every requested production module is complete. Card-provider integration, offline synchronization, KRA eTIMS, and invoice-generator connectivity are not implemented. Daraja M-Pesa and database-backed workflows require deployment configuration and end-to-end testing against a configured MySQL 8 instance before production use.

Before deploying, configure HTTPS, secrets, database backups, least-privilege database access, and operational monitoring. Use provider-approved test environments for external payments.
