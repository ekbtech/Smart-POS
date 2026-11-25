UPDATE role_permissions rp
JOIN roles r ON r.id = rp.role_id
SET rp.allowed = FALSE
WHERE r.name <> 'admin'
  AND rp.module_id IN (
    'sales',
    'transaction_own',
    'transaction_all',
    'transaction_details',
    'transaction_print',
    'transaction_reprint',
    'transaction_export',
    'transaction_cancel',
    'transaction_refund'
  );
