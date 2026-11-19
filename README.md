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
