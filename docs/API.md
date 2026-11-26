# Smart POS API

The API is served under `/api`. Browser requests use an HttpOnly, SameSite=Lax session cookie. Mutating requests must include the configured client `Origin`; JSON request bodies are limited to 100 KB.

## Authentication

### `POST /auth/login`

```json
{ "identifier": "admin@example.com", "password": "your-password" }
```

Use an administrator email or staff username in `identifier`. On success, sets the `smart_pos_session` cookie and returns roles, effective modules and the authorized default landing page. Login is rate limited and account lockout is enforced after repeated failures.

### `GET /auth/me`

Returns the current user profile; requires a valid session cookie.

### `POST /auth/logout`

Revokes the server-side session and clears the cookie.

## POS authentication

- `POST /pos/login` — database-backed POS cashier login. Requires a four-character minimum username and password. Five incorrect attempts temporarily lock the account for 15 minutes.
- `GET /pos/session` — verifies the dedicated two-hour POS session. Requires the main application session and authorized cashier role.
- `POST /pos/heartbeat` — refreshes POS presence; `{ "active": true }` also updates last activity, while an idle heartbeat keeps the session online without marking the cashier active.
- `POST /pos/logout` — revokes the dedicated POS session and records a POS logout audit event.
- `POST /pos/scanner/pairing` — create a one-time phone scanner QR pairing for the active POS session.
- `POST /products/scanner/pairing` — administrator, manager, or inventory manager with Products access; create a one-time phone pairing scoped to the current authenticated product-registration session.
- `POST /pos/scanner/pair/:id` — exchange a one-time QR token for a scanner bearer token; response includes the pairing mode (`pos` or `registration`). Pair tokens expire after 90 seconds and can be exchanged only once.
- `GET /products/scanner/pairing/:id/poll`, `POST /products/scanner/pairing/:id/ack`, `DELETE /products/scanner/pairing/:id` — poll registration-mode phone barcode events, return scan results to the phone, and revoke pairing. All require the owning authenticated user and Products access.
- `POST /pos/scanner/:id/scans`, `GET /pos/scanner/:id/status`, `POST /pos/scanner/:id/reconnect`, `POST /pos/scanner/:id/disconnect` — scanner-bearer-authenticated phone operations; barcode scans are queued to the owning laptop session, and disconnect revokes the scanner token.
- `GET /pos/scanner/pairing/:id/poll`, `POST /pos/scanner/pairing/:id/ack`, `DELETE /pos/scanner/pairing/:id` — active POS-session operations to receive/acknowledge barcode scans and revoke pairing.

POS sales, held-sale listing, hold and retrieval require the main authenticated session and a POS session bound to the same user. The POS session is established from the validated workspace login; it cannot switch cashier identity and expires no later than the workspace session.

- `GET /pos/scanner/product?barcode=4006381333931` — authenticated active POS session; performs an exact barcode lookup against active products and available inventory in the cashier's branch only. It never calls an external catalogue. The POS keyboard-wedge scanner uses this local path for barcode input; ordinary typed product searches remain catalogue searches.

## Access permissions

- `GET /access/modules` — administrator-only module catalog.
- `GET /access/roles` and `PUT /access/roles/:role` — administrator-only role permission templates.
- `GET /access/users/:id` — administrator-only individual module overrides and default landing page.
- `PUT /access/users/:id` — administrator-only update of default landing page and module overrides.

The sidebar and frontend routes consume effective modules. Backend APIs independently enforce module middleware and role middleware.

The `sales` module is shown as **Transaction History** in the administrator module and permission editors. Migration `021_transaction_history_permissions.sql` adds granular transaction permissions. Migration `022_admin_granted_transaction_history.sql` disables inherited Transaction History and transaction-action permissions for every non-admin role. Administrators grant history access per user by allowing `sales` and either `transaction_own` or `transaction_all`; `transaction_details` is also required to open a transaction receipt. Other transaction actions can be granted individually. Explicit user permission overrides are preserved.

Migration `023_live_cashier_monitoring.sql` adds the **Live Cashier Monitoring** module, shift counter/till number, and POS activity timestamps. Admins can monitor all branches; authorized managers are limited to their assigned branch. `GET /cashier-monitoring` accepts `scope=shift|today|custom`, optional `from`/`to`, and branch, cashier, and counter filters. `GET /cashier-monitoring/live` streams snapshot updates over Server-Sent Events, with 10-second client polling as a connectivity fallback. `GET /cashier-monitoring/cashiers/:id` returns current open-shift details and transactions; `GET /cashier-monitoring/sales/:id` returns a monitored receipt and item breakdown. Only completed sales and completed payment/refund records contribute to financial totals; pending and cancelled sales are excluded. Set `CASHIER_PRESENCE_TIMEOUT_SECONDS` (30–900, default 90) and `CASHIER_IDLE_TIMEOUT_SECONDS` (60–3600, default 300) to configure presence and idle status.

## Dashboard and catalogue

- `GET /dashboard/summary` — today's completed sales, transaction count, active product count, low-stock items, and five recent sales for the user's branch.
- `GET /reports/summary?from=YYYY-MM-DD&to=YYYY-MM-DD` — branch-scoped sales, refunds, cashier/product/category/payment breakdowns, expenses, purchase receipts, inventory valuation, and low stock. Admin, manager, or accountant only. Dates are inclusive; omitted dates default to the latest 30 calendar days, and ranges are limited to 366 days. The report screen supports CSV export.
- `GET /products?search=milk&page=1&pageSize=20&category=Dairy&stockStatus=low_stock&sort=stock&direction=asc` — active products with branch-available stock, server-side search/filter/sort, and pagination. `pageSize` is 1–100; `stockStatus` is `in_stock`, `low_stock`, or `out_of_stock`. Search terms match partial product names, SKUs, and barcodes.
- `GET /products/categories` — categories used by active products.
- `POST /products/lookup/barcode` — admin, manager, or inventory manager only; rate-limited to 20 requests/minute. Accepts a printable barcode up to 64 characters. The API checks the local product table first. If the barcode already belongs to an active or archived product, it returns `{ "found": false, "duplicate": { "id": 8, "sku": "TEA-8", "name": "Existing tea", "isActive": true } }` and does not contact the external service. Unregistered EAN-13, EAN-8, UPC-A, and UPC-E values are queried against Open Food Facts; other barcode formats are retained for manual registration without an external request. Returns `{ "found": false }` when no catalogue match exists, or only the available `name`, `description`, `brand`, `category`, `packageSize`, and allowlisted `imageUrl` fields. External lookup failures return HTTP 502 and do not block manual product entry.
- `POST /products` — admin, manager, or inventory manager only. Registers a product (including optional `brand`, `packageSize`, and `description`), creates its category if needed, sets the branch's opening stock, and writes an opening stock movement and audit event. Existing unique SKU and barcode indexes reject duplicate registrations.
- `PATCH /products/:id` — update catalogue fields; same roles as creation. Set `{ "isActive": false }` to archive a product; archiving is refused while any branch has on-hand/reserved inventory or an open purchase order containing the product.
- `GET /products/:id/image` — authenticated product/inventory module access; returns the private product image.
- `PUT /products/:id/image` — admin, manager, or inventory manager only. Send a raw JPEG, PNG, or WebP body (`Content-Type: image/jpeg`, `image/png`, or `image/webp`), maximum 5 MB. Images are stored in MySQL by migration 011.
- `POST /products/:id/image/import` — admin, manager, or inventory manager only. Accepts an `imageUrl` returned by product lookup, downloads only from the HTTPS Open Food Facts image host, validates JPEG/PNG/WebP bytes, and stores the image using the existing image storage.
- `DELETE /products/:id/image` — remove the stored image; same roles as product updates.

The Products screen supports CSV import and export. CSV imports create products one at a time, preserve per-row failures in the result, and accept up to 1,000 rows per file. Required columns are `sku`, `name`, `category`, `unit`, and `sellingPrice`; optional columns include `barcode`, `brand`, `packageSize`, `description`, `purchasePrice`, `taxRate`, `reorderLevel`, and `openingStock`.

```json
{
  "sku": "DAIR-012",
  "barcode": "600100100012",
  "name": "Long-life milk 1L",
  "brand": "Example Brand",
  "packageSize": "1 L",
  "description": "Long-life milk drink",
  "category": "Dairy",
  "unit": "piece",
  "sellingPrice": "165.00",
  "purchasePrice": "110.00",
  "taxRate": "16.00",
  "reorderLevel": "8",
  "openingStock": "20"
}
```

Apply migrations `016_product_lookup_fields.sql`, `017_product_description.sql`, and `018_mobile_registration_scanner.sql` before deploying these fields and registration scanner pairing. CSV import/export also supports the optional `description` field.

## Checkout

### `POST /sales`

Requires a valid session, same-origin request, and a unique `Idempotency-Key` header (up to 100 characters).

```json
{
  "items": [{ "productId": 3, "quantity": "2" }],
  "discount": "0.00",
  "cashReceived": "150.00",
  "payments": [{ "method": "cash", "amount": "136.00" }]
}
```

Quantities are decimal strings with up to three fractional digits. Monetary values are decimal strings with up to two fractional digits. The API recalculates totals and tax from database product records; client-submitted unit prices are not accepted. The sum of cash payment allocations must equal the calculated total. Duplicate product lines are rejected; combine quantities into one line.

`cashReceived` is the drawer tendered amount and must be at least the calculated total; it is optional for API clients and defaults to the payment allocation total. The difference is recorded as change due. Change cannot be issued against a non-cash payment.

Apply migrations `012_sale_cash_tender.sql`, `013_bank_transfer_verification.sql`, and `019_mpesa_payment_requests.sql` before deploying this checkout/receipt update; they add persisted cash tender/change, bank-transfer authorization, and M-Pesa payment/callback records.

Checkout locks the relevant inventory rows and writes the sale, item snapshots, payment, stock movements, and audit event inside one database transaction. A repeated idempotency key returns the original sale. Insufficient stock returns HTTP 409. Cash is enabled. Bank transfer requires an administrator to approve a submitted reference and exact amount after independently verifying it against the bank; checkout consumes that authorization in the same transaction as the sale. Split tender supports cash plus an administrator-verified bank transfer. Card checkout records the cashier-confirmed terminal reference; the POS does not independently validate it with a card provider, so only complete the sale after the terminal confirms approval. M-Pesa remains Daraja-verified and cannot be completed using a cashier-entered code alone. Never treat an initiated or unconfirmed external payment as paid.

### Daraja M-Pesa STK Push

- `GET /mpesa/config` — reports whether the server has usable Daraja configuration; it never returns credentials.
- `POST /mpesa/payments` — creates an STK Push request from the current product IDs, quantities, discount, customer phone (`07XXXXXXXX` or `2547XXXXXXXX`), and a description of at most 13 characters. Requires an open shift and a unique `Idempotency-Key`; returns HTTP 202 with a payment request ID and status.
- `GET /mpesa/payments/:id` — returns the requesting cashier's payment status. Polling triggers Daraja STK Query verification where possible.
- `POST /mpesa/payments/:id/cancel` — cancels a failed request after its stock reservation has been released.
- `POST /mpesa/callback` — unauthenticated Daraja webhook endpoint configured as the public HTTPS callback URL. It stores callback events; a sale is finalized only after server-side Daraja query confirmation and matching callback phone, amount, and transaction code.

M-Pesa requests reserve available inventory while pending. Uncertain provider outcomes retain the reservation and must be reconciled before another payment is taken; do not retry an unknown request. Daraja STK Push accepts whole Kenyan shillings, so totals containing cents are rejected rather than rounded. The integration is inactive until the server environment contains `MPESA_ENVIRONMENT` (`sandbox` or `production`), `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_SHORTCODE`, `MPESA_PASSKEY`, and a reachable HTTPS `MPESA_CALLBACK_URL` ending in `/api/mpesa/callback`. Optionally set `MPESA_TRANSACTION_TYPE`. Never expose these values as `VITE_*` variables. Use the provider sandbox and verify the callback path from outside the local network before production.

After a completed sale, the POS opens the receipt and invokes the browser print API. Standard browser sessions display a print dialog. For silent printing to the Windows default printer, launch Edge or Chrome with kiosk printing enabled by using `scripts/start-pos-kiosk.ps1`. The receipt preview also offers browser **Save as PDF** through the print dialog. Set `RECEIPT_BUSINESS_NAME`, `RECEIPT_BUSINESS_PHONE`, `RECEIPT_BUSINESS_ADDRESS`, and optionally `RECEIPT_LOGO_URL` on the server to customize receipt branding.

Checkout requires an open cashier shift for the signed-in user. Start one with `POST /shifts/open` before using the POS.

Each checkout stores the calculated tax-exclusive line amount, tax amount, and available unit purchase cost. Receiving purchase-order goods updates product purchase cost using a weighted average over positive on-hand inventory. Historical sale lines without known cost remain unknown; profit fields are `null` unless all applicable sale and return quantities have cost data.

Checkout locks and consumes unexpired inventory lots in earliest-expiry order. Products with expired lots have those quantities excluded from available-to-sell stock. Legacy stock present when migration 005 is applied is kept as a non-expiring legacy lot until its expiry is recorded by a later receipt/count.

## Staff administration

- `GET /staff?search=...` — branch staff directory, current roles, department, account status, and most recent login; admin or manager.
- `GET /staff/departments` — departments available for employee assignment; admin or manager.
- `POST /staff` — create a branch staff account; admin or manager.
- `PATCH /staff/:id/status` — activate/deactivate an account; admin only.

```json
{
  "name": "Alex Cashier",
  "email": "alex@example.com",
  "password": "a-unique-temporary-password",
  "role": "cashier",
  "departmentId": 2,
  "jobTitle": "Cashier",
  "phone": "+254700000000",
  "hiredAt": "2026-11-18"
}
```

Passwords must be at least 4 characters and are hashed before storage. Managers can create staff accounts for operational roles but cannot grant admin or manager privileges. Admins can create any role. Deactivating a user revokes their active sessions; the branch cannot be left without an active administrator, and admins cannot deactivate their own account.

```json
{ "isActive": false }
```

## Inventory

- `GET /inventory?search=milk` — branch balances and recent stock movements.
- `GET /inventory/summary` — exact active-product, available-stock, low/out-of-stock, and purchase-cost valuation totals for the user's branch. Valuation excludes products without a purchase cost; the response reports their count.
- `POST /inventory/adjustments` — admin, manager, or inventory manager.
- `GET /inventory/expiry?days=90` — batches already expired or due to expire within 1–365 days; defaults to 90.
- `GET /inventory/transfer-branches` — destination branches other than the user's assigned branch.
- `GET /inventory/transfers` — recent transfers where the user's branch is sender or receiver.
- `POST /inventory/transfers` — create a draft transfer from the user's branch.
- `GET /inventory/transfers/:id` — inspect a transfer visible to its source or destination branch.
- `POST /inventory/transfers/:id/dispatch` — deduct stock from the source branch and move the transfer into transit.
- `POST /inventory/transfers/:id/receive` — receive items into the destination branch; lower quantities are recorded as discrepancies.
- `GET /inventory/stock-takes` — recent branch stock counts.
- `POST /inventory/stock-takes` — start a full branch count of active products with the current system quantities.
- `GET /inventory/stock-takes/:id` — read a branch stock count and its product list.
- `POST /inventory/stock-takes/:id/complete` — submit one nonnegative physical quantity per product; reconciles inventory and batch quantities transactionally. Admin, manager, or inventory manager only.

```json
{ "productId": 3, "direction": "in", "quantity": "5", "reason": "Verified stock count" }
```

Adjustments are transactional, reject stock-out quantities exceeding available stock, and record a movement and audit event.

Stock-in adjustments and purchase receipts can include `batchCode` and `expiryDate` (`YYYY-MM-DD`). For example:

```json
{
  "reference": "DELIVERY-001",
  "items": [{ "purchaseOrderItemId": 1, "quantity": "5", "batchCode": "LOT-778", "expiryDate": "2027-06-30" }]
}
```

Batch metadata is optional for non-perishable goods. The inventory screen highlights expired and near-expiry stock and supports full physical counts. A stock count posts only differences as `stock_take` movements and records the count/audit result.

Transfers are branch-scoped and require an admin, manager, or inventory manager. Dispatch consumes source inventory and records batch, expiry, and cost snapshots; receipt recreates those lots at the destination. The receiving branch must report one quantity per item, not exceeding the dispatched amount. Any shortage is recorded on the transfer and in its audit log. Transfers cannot be edited or cancelled after dispatch.

## Suppliers and purchasing

The Suppliers and Customers workspaces are presented together under the **Business Partners** navigation entry, with separate tabs. Their module permissions and API endpoints remain independent: `suppliers` controls supplier records and `customers` controls customer records. Migration `024_business_partners_workspace.sql` updates module labels/routes and existing default landing pages.

Notifications, User Management, Price History, Backups, and Offline Sync are grouped under the **Settings** workspace with separate tabs and their existing module permissions. User Management remains administrator-only. Migration `025_settings_workspace.sql` updates module labels/routes and existing default landing pages.

- `GET /suppliers`
- `POST /suppliers` — admin, manager, or procurement officer.
- `GET /purchase-orders`
- `POST /purchase-orders` — create a draft; admin, manager, or procurement officer.
- `GET /purchase-orders/:id`
- `POST /purchase-orders/:id/approve` — admin or manager.
- `POST /purchase-orders/:id/receive` — admin, manager, procurement officer, or inventory manager.

Create a draft order with:

```json
{
  "supplierId": 2,
  "notes": "Deliver to the main store",
  "items": [{ "productId": 3, "quantity": "12", "unitCost": "110.00" }]
}
```

An approved order can be received in partial deliveries:

```json
{
  "reference": "DELIVERY-001",
  "items": [{ "purchaseOrderItemId": 1, "quantity": "5" }]
}
```

Only the quantity received is added to stock.

## Customers

- `GET /customers?search=...`
- `POST /customers` — admin, manager, cashier, or accountant.

```json
{ "name": "Jane Customer", "phone": "+254700000000", "email": "jane@example.com", "address": "Nairobi" }
```

## Cashier shifts

- `GET /shifts/active` — the signed-in user's active shift, if any.
- `POST /shifts/open` — admin, manager, or cashier.
- `POST /shifts/cash-movements` — record `deposit` or `withdrawal` against the open shift.
- `POST /shifts/close` — reconcile and close the open shift.

```json
{ "openingCash": "5000.00" }
```

Cash movement example:

```json
{ "type": "withdrawal", "amount": "200.00", "description": "Petty cash with approval" }
```

To close, submit the counted drawer amount:

```json
{ "actualCash": "6800.00" }
```

The close response includes the system-expected cash and the variance.

## Expenses

- `GET /expenses`
- `POST /expenses` — admin, manager, accountant, or cashier; creates a pending submission.
- `POST /expenses/:id/decision` — admin, manager, or accountant; body is `{ "decision": "approved" }` or `{ "decision": "rejected" }`.

```json
{
  "category": "Utilities",
  "amount": "2500.00",
  "description": "Monthly electricity token",
  "paymentMethod": "mpesa"
}
```

Expense payment method is descriptive bookkeeping only; this endpoint does not initiate a payment.

## Sales and refunds

- `GET /sales?q=...&cashier=...&from=YYYY-MM-DD&to=YYYY-MM-DD&paymentMethod=...&status=...&branchId=...` — up to 500 recent transactions, with filters for receipt/ID/customer, cashier, date range, payment method, status, and (administrators only) branch. Cashiers are always restricted to their own cashier ID and branch unless an administrator grants `transaction_all`.
- `GET /sales/:id` — transaction details, receipt data, items, totals, cashier, payment, and tender details; requires `transaction_details` and own/all transaction scope.
- `GET /sales/:id/receipt` — receipt reprint lookup; requires `sales` or `receipts`, `transaction_reprint`, and own/all transaction scope.
- `GET /sales/export` — CSV export using the same filters; requires `transaction_export`.
- `GET /pos/sales/:id/receipt` — POS receipt lookup restricted to the authenticated POS user and branch.
- `GET /sales/held` — held sales for the authenticated cashier.
- `POST /sales/held` — hold the current cart for later retrieval.
- `POST /sales/held/:id/retrieve` — retrieve and remove a cashier's held sale.
- `POST /bank-transfer-verifications` — cashier submits a reference and sale amount for administrator review; does not complete a sale or update stock.
- `GET /bank-transfer-verifications/status?reference=...` — cashier checks their submitted reference status.
- `GET /bank-transfer-verifications` — admin-only list of pending transfers for the branch.
- `POST /bank-transfer-verifications/:id/decision` — admin-only `{ "decision": "approved" }` or `{ "decision": "rejected" }`; approve only after confirming the transfer in the bank account.
- `GET /refunds` — recent cash refunds, scoped to the user's branch and transaction visibility.
- `POST /sales/:id/refunds` — requires `transaction_refund`; records the refund, restores returned stock, and writes an audit event in one transaction.
- `POST /sales/:id/cancel` — requires `transaction_cancel`; cancels only pending-payment records that have no completed payment or sale stock movement, and writes an audit event.

```json
{
  "reason": "Customer returned unopened item",
  "items": [{ "saleItemId": 7, "quantity": "1" }]
}
```

The API rejects quantities above the unrefunded quantity and prevents total refunds from exceeding the original line amount. A fully refunded sale is displayed with `refunded` status; `pending_payment` is displayed as `pending`.

## Operational notes

These endpoints require their corresponding database migrations to be applied. Database-backed workflows should be exercised against a configured MySQL 8 instance before production use. Provider integrations, offline synchronization, attendance tracking, inter-branch transfers, and invoice-generator connectivity are not currently exposed by this API. Receipt print and PDF output use the browser print dialog.
