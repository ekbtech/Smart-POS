UPDATE modules
SET name='Business Partners - Suppliers', route='/business-partners/suppliers'
WHERE id='suppliers';

UPDATE modules
SET name='Business Partners - Customers', route='/business-partners/customers'
WHERE id='customers';

UPDATE users
SET default_landing = CASE default_landing
  WHEN '/suppliers' THEN '/business-partners/suppliers'
  WHEN '/customers' THEN '/business-partners/customers'
  ELSE default_landing
END
WHERE default_landing IN ('/suppliers', '/customers');
