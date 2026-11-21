# Smart POS

A React + TypeScript retail operations application with an Express API and MySQL persistence. The current foundation includes authenticated, role-gated access; branch-scoped staff management; an editable product catalogue; inventory adjustments, expiry batches, physical stock counts, and inter-branch transfers; supplier and purchase-order workflows; customer records; cashier shifts and cash movements; expense submissions and approvals; sales history and cash refunds; transactional cash checkout; and branch-scoped reports with CSV export.

## Requirements

- Node.js 20+
- MySQL 8+

## Local setup

1. Copy `.env.example` to `.env` and set a strong `JWT_SECRET`, MySQL connection, and initial admin credentials.
2. Create the configured MySQL database and user.
3. Run `npm install`.
4. Run `npm run db:migrate` and `npm run db:seed`.
5. Run `npm run dev`. The web app is at `http://localhost:5173`; the API listens on port 4000.

### Android phone barcode scanner

The cashier can choose **Phone scanner** in POS to pair one Android phone with the current register. The phone opens the Smart POS app at `/mobile-scanner`, uses the rear camera (EAN-13, EAN-8, UPC-A, UPC-E, and Code 128), and sends barcodes to the paired cashier session. The register looks up active products and available stock for the cashier's branch and adds valid scans to the current sale. Manual barcode entry and reconnect controls are also available on the phone. The cashier can disconnect the paired phone from the pairing dialog. Scans only add items to the current cart; checkout remains responsible for sale completion and stock deduction.

For remote use across different networks, deploy the frontend and API at publicly reachable HTTPS origins and configure:

- `CLIENT_ORIGIN` to the exact frontend origin (scheme and host, plus port if nonstandard), allowing the browser's credentialed API requests.
- `VITE_API_BASE_URL` to the deployed API base URL, including `/api`.
- `VITE_PUBLIC_APP_URL` to the frontend HTTPS origin embedded in the pairing QR code.

These `VITE_*` values are read at frontend build time. Rebuild the client after changing them. The API uses HTTPS-secure cross-origin session cookies in production. Android camera access requires a trusted HTTPS context. For local development, configure `SMARTPOS_TLS_CERT` and `SMARTPOS_TLS_KEY` with trusted certificate paths relative to the repository root, and use a certificate whose subject alternative name matches the frontend hostname. Do not expose the development server directly to the internet.

Apply the `015_mobile_scanner.sql` migration with `npm run db:migrate` before deploying the API. Pairing tokens are single-use and expire after 90 seconds; scanner bearer tokens are stored only as hashes, bound to the active POS session and branch, and revoked when the cashier disconnects or logs out. Pending scans and pairing state are stored in MySQL, so they survive API restarts and can be shared by multiple API instances. The phone and register exchange status and queued scans using authenticated HTTPS polling (not WebSockets); the POS polls approximately every 1.2 seconds. Pair again if the pairing expires. Verify the deployed HTTPS origins, CORS configuration, migration, and Android camera access in the target environment before relying on remote scanning.

### Two-stage product barcode identification

In Products, **Scan** opens an in-page camera scanner for EAN-13, EAN-8, UPC-A, UPC-E, and Code 128. Before any internet request, the API checks the existing product table for the exact barcode; an existing active or archived product is reported as a duplicate and is not sent to an external catalogue. Unregistered numeric EAN/UPC barcodes are looked up in Open Food Facts; other barcode formats are retained for manual registration without an unsupported online request. Returned name, generic description, brand, category, package size, and allowlisted product image are used only when the catalogue actually provides them. Staff can edit the retrieved fields, enter details manually when there is no match or the API is unavailable, or generate an internal-use EAN-13 with the restricted-circulation `20` prefix. Database uniqueness constraints remain the final protection against duplicate SKUs and barcodes. Imported images are downloaded by the API only from Open Food Facts image hosts, validated, limited to 5 MB, and stored using the existing product-image storage.

At POS checkout, USB/keyboard-emulating scanners and paired phone scanners resolve barcodes against the local branch inventory only. Unknown scanned barcodes display “Product not found in inventory. Contact administrator.” The cashier cannot register products from checkout; scanning only adds or increments a cart item and does not complete a sale or deduct stock. Ordinary typed product search remains available.

Run `npm run db:migrate` to apply migrations `016_product_lookup_fields.sql` and `017_product_description.sql` before deploying these fields. They are additive and preserve existing catalogue data. Registration lookup requires outbound HTTPS access from the API to `world.openfoodfacts.org`; checkout does not make an external request. Open Food Facts coverage is incomplete, so verify returned values before saving. The scanner uses the existing ZXing library and requires a trusted HTTPS browser context for camera access.

The seed command refuses to run without an explicitly configured admin password. Keep `.env` private.

## API

The API is served under `/api`. Authentication, staff, dashboard, reports, catalogue, checkout, inventory, supplier, purchase order, customer, shift, expense, and refund endpoints are documented in [docs/API.md](./docs/API.md).

All monetary values are stored as MySQL `DECIMAL`. The sale API computes prices and totals from the database, locks inventory rows, rejects insufficient stock by default, and commits sale, payments, stock movements, and audit data in one transaction. Only cash is enabled at checkout. External payments and credit sales are explicitly rejected until their confirmation and authorization workflows are implemented; an initiated payment must never be treated as confirmed.

## Project layout

- `client/` — React, Vite, Tailwind CSS, React Router, TanStack Query.
- `server/` — Express API, validation, authentication, and MySQL services.
- `server/migrations/` — versioned SQL migrations.

## Current scope and remaining work

The operations listed above have application screens and API workflows. Product archival is blocked while any branch has on-hand/reserved inventory or an open purchase order. Receiving can record batch codes and expiry dates; checkout consumes unexpired lots by earliest expiry, and expired quantities are excluded from saleable stock. Stock counts snapshot active products and reconcile variances through the inventory and batch ledgers. Inter-branch transfers move quantity and lot metadata on dispatch, then reconcile received quantities and shortages at the destination. Reports cover sales trends, cashiers, products, categories, payment mix, expenses, purchasing, inventory valuation, and low stock; CSV export is provided. Gross and net profit are suppressed when cost snapshots are incomplete. This is still an incremental foundation, not a claim that every requested production module is complete. Attendance/work schedules, PDF exports, offline synchronization, M-PESA/card/bank payment providers, KRA eTIMS, and invoice-generator connectivity are not implemented. Those integrations require business credentials, current provider documentation, and end-to-end testing before they can be described as production-ready. Database-backed workflows also need validation against a configured MySQL 8 instance before deployment.

Before deploying, configure HTTPS, secrets, database backups, least-privilege database access, and operational monitoring. Use provider-approved test environments for external payments.
