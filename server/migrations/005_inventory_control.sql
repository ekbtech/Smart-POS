CREATE TABLE inventory_batches (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  branch_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  batch_code VARCHAR(80) NULL,
  expiry_date DATE NULL,
  quantity_received DECIMAL(12,3) NOT NULL,
  quantity_remaining DECIMAL(12,3) NOT NULL,
  unit_cost DECIMAL(12,2) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_inventory_batches_fifo (branch_id, product_id, expiry_date, id),
  CONSTRAINT fk_inventory_batches_branch FOREIGN KEY (branch_id) REFERENCES branches(id),
  CONSTRAINT fk_inventory_batches_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT chk_inventory_batches_quantity CHECK (quantity_received > 0 AND quantity_remaining >= 0 AND quantity_remaining <= quantity_received)
) ENGINE=InnoDB;

INSERT INTO inventory_batches (branch_id, product_id, batch_code, expiry_date, quantity_received, quantity_remaining, unit_cost)
SELECT i.branch_id, i.product_id, 'LEGACY-OPENING', NULL, i.on_hand, i.on_hand, p.purchase_price
FROM inventory i
JOIN products p ON p.id = i.product_id
WHERE i.on_hand > 0;

CREATE TABLE sale_item_batches (
  sale_item_id BIGINT UNSIGNED NOT NULL,
  inventory_batch_id BIGINT UNSIGNED NOT NULL,
  quantity DECIMAL(12,3) NOT NULL,
  PRIMARY KEY (sale_item_id, inventory_batch_id),
  CONSTRAINT fk_sale_item_batches_sale_item FOREIGN KEY (sale_item_id) REFERENCES sale_items(id),
  CONSTRAINT fk_sale_item_batches_batch FOREIGN KEY (inventory_batch_id) REFERENCES inventory_batches(id),
  CONSTRAINT chk_sale_item_batches_quantity CHECK (quantity > 0)
) ENGINE=InnoDB;

ALTER TABLE stock_movements
  MODIFY movement_type ENUM('opening', 'sale', 'reservation', 'release', 'adjustment', 'receipt', 'return', 'damage', 'transfer', 'stock_take') NOT NULL;

CREATE TABLE stock_takes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  branch_id BIGINT UNSIGNED NOT NULL,
  reference VARCHAR(40) NOT NULL UNIQUE,
  title VARCHAR(180) NOT NULL,
  status ENUM('draft', 'completed') NOT NULL DEFAULT 'draft',
  created_by BIGINT UNSIGNED NOT NULL,
  completed_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP NULL,
  INDEX idx_stock_takes_branch_date (branch_id, created_at),
  CONSTRAINT fk_stock_takes_branch FOREIGN KEY (branch_id) REFERENCES branches(id),
  CONSTRAINT fk_stock_takes_creator FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT fk_stock_takes_completer FOREIGN KEY (completed_by) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE stock_take_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  stock_take_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  expected_quantity DECIMAL(12,3) NOT NULL,
  counted_quantity DECIMAL(12,3) NULL,
  variance DECIMAL(12,3) NULL,
  UNIQUE KEY uq_stock_take_product (stock_take_id, product_id),
  CONSTRAINT fk_stock_take_items_take FOREIGN KEY (stock_take_id) REFERENCES stock_takes(id),
  CONSTRAINT fk_stock_take_items_product FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB;
