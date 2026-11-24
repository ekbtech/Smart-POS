UPDATE modules
SET name = 'Transaction History'
WHERE id = 'sales';

INSERT INTO modules (id, name, route, sort_order) VALUES
  ('transaction_own', 'View Own Transactions', '/sales', 31),
  ('transaction_all', 'View All Cashiers'' Transactions', '/sales', 32),
  ('transaction_details', 'View Transaction Details', '/sales', 33),
  ('transaction_print', 'Print Receipts', '/sales', 34),
  ('transaction_reprint', 'Reprint Receipts', '/sales', 35),
  ('transaction_export', 'Export Transaction Reports', '/sales', 36),
  ('transaction_cancel', 'Cancel Transactions', '/sales', 37),
  ('transaction_refund', 'Process Refunds', '/sales', 38)
ON DUPLICATE KEY UPDATE name=VALUES(name), route=VALUES(route), sort_order=VALUES(sort_order);

INSERT INTO role_permissions (role_id, module_id, allowed)
SELECT r.id, m.id, TRUE
FROM roles r CROSS JOIN modules m
WHERE r.name = 'admin'
  AND m.id IN (
    'transaction_own', 'transaction_all', 'transaction_details', 'transaction_print',
    'transaction_reprint', 'transaction_export', 'transaction_cancel', 'transaction_refund'
  )
ON DUPLICATE KEY UPDATE allowed=TRUE;

INSERT INTO role_permissions (role_id, module_id, allowed)
SELECT r.id, m.id, TRUE
FROM roles r CROSS JOIN modules m
WHERE r.name = 'manager'
  AND m.id IN (
    'transaction_own', 'transaction_all', 'transaction_details', 'transaction_print',
    'transaction_reprint', 'transaction_export', 'transaction_cancel', 'transaction_refund'
  )
ON DUPLICATE KEY UPDATE allowed=TRUE;

INSERT INTO role_permissions (role_id, module_id, allowed)
SELECT r.id, m.id, TRUE
FROM roles r CROSS JOIN modules m
WHERE r.name = 'accountant'
  AND m.id IN (
    'transaction_own', 'transaction_all', 'transaction_details', 'transaction_print',
    'transaction_reprint', 'transaction_export'
  )
ON DUPLICATE KEY UPDATE allowed=TRUE;

INSERT INTO role_permissions (role_id, module_id, allowed)
SELECT r.id, m.id, TRUE
FROM roles r CROSS JOIN modules m
WHERE r.name = 'cashier'
  AND m.id IN ('transaction_own', 'transaction_details', 'transaction_print', 'transaction_reprint')
ON DUPLICATE KEY UPDATE allowed=TRUE;
