# Smart POS API

The API is served under `/api`. Browser requests use an HttpOnly, SameSite=Lax session cookie. Mutating requests must include the configured client `Origin`; JSON request bodies are limited to 100 KB.

## Authentication

### `POST /auth/login`

```json
{ "email": "admin@example.com", "password": "your-password" }
```

On success, sets the `smart_pos_session` cookie and returns the user profile and role names. Login is rate limited.

### `GET /auth/me`

Returns the current user profile; requires a valid session cookie.

### `POST /auth/logout`

Revokes the server-side session and clears the cookie.

## Dashboard and catalogue

- `GET /dashboard/summary` — today's completed sales, transaction count, active product count, low-stock items, and five recent sales for the user's branch.
- `GET /reports/summary?from=YYYY-MM-DD&to=YYYY-MM-DD` — branch-scoped sales, refunds, cashier/product/category/payment breakdowns, expenses, purchase receipts, inventory valuation, and low stock. Admin, manager, or accountant only. Dates are inclusive; omitted dates default to the latest 30 calendar days, and ranges are limited to 366 days. The report screen supports CSV export.
- `GET /products?search=milk` — up to 100 active products with branch-available stock. A search term may match product name, SKU, or barcode.
- `POST /products` — admin, manager, or inventory manager only. Registers a product, creates its category if needed, sets the branch's opening stock, and writes an opening stock movement and audit event.
- `PATCH /products/:id` — update catalogue fields; same roles as creation. Set `{ "isActive": false }` to archive a product; archiving is refused while any branch has on-hand/reserved inventory or an open purchase order containing the product.

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
- `POST /inventory/adjustments` — admin, manager, or inventory manager.
- `GET /inventory/expiry?days=90` — batches already expired or due to expire within 1–365 days; defaults to 90.
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
