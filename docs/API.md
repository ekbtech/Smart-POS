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
- `POST /pos/logout` — revokes the dedicated POS session and records a POS logout audit event.

POS sales, held-sale listing, hold and retrieval require both the main authenticated session and an active dedicated POS session. A POS session is independent of the main application login and must be repeated after logout or expiry.

## Access permissions

- `GET /access/modules` — administrator-only module catalog.
- `GET /access/users/:id` — administrator-only individual module overrides and default landing page.
- `PUT /access/users/:id` — administrator-only update of default landing page and module overrides.

The sidebar and frontend routes consume effective modules. Backend APIs independently enforce module middleware and role middleware.

## Dashboard and catalogue

- `GET /dashboard/summary` — today's completed sales, transaction count, active product count, low-stock items, and five recent sales for the user's branch.
- `GET /reports/summary?from=YYYY-MM-DD&to=YYYY-MM-DD` — branch-scoped sales, refunds, cashier/product/category/payment breakdowns, expenses, purchase receipts, inventory valuation, and low stock. Admin, manager, or accountant only. Dates are inclusive; omitted dates default to the latest 30 calendar days, and ranges are limited to 366 days. The report screen supports CSV export.
- `GET /products?search=milk&page=1&pageSize=20&category=Dairy&stockStatus=low_stock&sort=stock&direction=asc` — active products with branch-available stock, server-side search/filter/sort, and pagination. `pageSize` is 1–100; `stockStatus` is `in_stock`, `low_stock`, or `out_of_stock`. Search terms match partial product names, SKUs, and barcodes.
- `GET /products/categories` — categories used by active products.
- `POST /products` — admin, manager, or inventory manager only. Registers a product, creates its category if needed, sets the branch's opening stock, and writes an opening stock movement and audit event.
- `PATCH /products/:id` — update catalogue fields; same roles as creation. Set `{ "isActive": false }` to archive a product; archiving is refused while any branch has on-hand/reserved inventory or an open purchase order containing the product.
- `GET /products/:id/image` — authenticated product/inventory module access; returns the private product image.
- `PUT /products/:id/image` — admin, manager, or inventory manager only. Send a raw JPEG, PNG, or WebP body (`Content-Type: image/jpeg`, `image/png`, or `image/webp`), maximum 5 MB. Images are stored in MySQL by migration 011.
- `DELETE /products/:id/image` — remove the stored image; same roles as product updates.

The Products screen supports CSV import and export. CSV imports create products one at a time, preserve per-row failures in the result, and accept up to 1,000 rows per file. Required columns are `sku`, `name`, `category`, `unit`, and `sellingPrice`; optional columns include `barcode`, `purchasePrice`, `taxRate`, `reorderLevel`, and `openingStock`.

```json
{
  "sku": "DAIR-012",
  "barcode": "600100100012",
  "name": "Long-life milk 1L",
  "category": "Dairy",
  "unit": "piece",
  "sellingPrice": "165.00",
  "purchasePrice": "110.00",
  "taxRate": "16.00",
  "reorderLevel": "8",
  "openingStock": "20"
}
```

## Checkout

### `POST /sales`

Requires a valid session, same-origin request, and a unique `Idempotency-Key` header (up to 100 characters).

```json
{
  "items": [{ "productId": 3, "quantity": "2" }],
  "discount": "0.00",
  "payments": [{ "method": "cash", "amount": "136.00" }]
}
```

Quantities are decimal strings with up to three fractional digits. Monetary values are decimal strings with up to two fractional digits. The API recalculates totals and tax from database product records; client-submitted unit prices are not accepted. The sum of cash payment allocations must equal the calculated total. Duplicate product lines are rejected; combine quantities into one line.

Checkout locks the relevant inventory rows and writes the sale, item snapshots, cash payment, stock movements, and audit event inside one database transaction. A repeated idempotency key returns the original sale. Insufficient stock returns HTTP 409. Only cash is currently enabled; card, M-PESA, bank transfer, and credit return HTTP 501 until their confirmation or authorization workflows are implemented. An initiated external payment must never be treated as paid.

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

Passwords must be at least 12 characters and are hashed before storage. Managers can create staff accounts for operational roles but cannot grant admin or manager privileges. Admins can create any role. Deactivating a user revokes their active sessions; the branch cannot be left without an active administrator, and admins cannot deactivate their own account.

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

- `GET /sales` — recent branch receipts.
- `GET /sales/:id` — receipt and item details.
- `GET /sales/held` — held sales for the authenticated cashier.
- `POST /sales/held` — hold the current cart for later retrieval.
- `POST /sales/held/:id/retrieve` — retrieve and remove a cashier's held sale.
- `GET /refunds` — recent cash refunds.
- `POST /sales/:id/refunds` — admin or manager; records a cash refund and restores returned stock in one transaction.

```json
{
  "reason": "Customer returned unopened item",
  "items": [{ "saleItemId": 7, "quantity": "1" }]
}
```

The API rejects quantities above the unrefunded quantity and prevents total refunds from exceeding the original line amount.

## Operational notes

These endpoints require their corresponding database migrations to be applied. Database-backed workflows should be exercised against a configured MySQL 8 instance before production use. Provider integrations, offline synchronization, attendance tracking, inter-branch transfers, PDF exports, and invoice-generator connectivity are not currently exposed by this API.
