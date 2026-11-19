CREATE TABLE held_sales (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  branch_id BIGINT UNSIGNED NOT NULL,
  cashier_id BIGINT UNSIGNED NOT NULL,
  hold_number VARCHAR(40) NOT NULL UNIQUE,
  customer_id BIGINT UNSIGNED NULL,
  discount DECIMAL(12,2) NOT NULL DEFAULT 0,
  cart JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_held_sales_branch_cashier (branch_id, cashier_id, created_at),
  CONSTRAINT fk_held_sales_branch FOREIGN KEY (branch_id) REFERENCES branches(id),
  CONSTRAINT fk_held_sales_cashier FOREIGN KEY (cashier_id) REFERENCES users(id),
  CONSTRAINT fk_held_sales_customer FOREIGN KEY (customer_id) REFERENCES customers(id)
) ENGINE=InnoDB;
