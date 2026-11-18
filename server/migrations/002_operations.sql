ALTER TABLE stock_movements
  MODIFY movement_type ENUM('opening', 'sale', 'reservation', 'release', 'adjustment', 'receipt', 'return', 'damage', 'transfer') NOT NULL;

ALTER TABLE products
  ADD COLUMN purchase_price DECIMAL(12,2) NULL AFTER selling_price;

CREATE TABLE suppliers (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(180) NOT NULL,
  contact_name VARCHAR(150) NULL,
  email VARCHAR(254) NULL,
  phone VARCHAR(40) NULL,
  address VARCHAR(500) NULL,
  tax_pin VARCHAR(30) NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_suppliers_name (name)
) ENGINE=InnoDB;

CREATE TABLE purchase_orders (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  branch_id BIGINT UNSIGNED NOT NULL,
  supplier_id BIGINT UNSIGNED NOT NULL,
  order_number VARCHAR(40) NOT NULL UNIQUE,
  status ENUM('draft', 'ordered', 'partially_received', 'received', 'cancelled') NOT NULL DEFAULT 'draft',
  notes VARCHAR(1000) NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_purchase_orders_branch_date (branch_id, created_at),
  CONSTRAINT fk_purchase_orders_branch FOREIGN KEY (branch_id) REFERENCES branches(id),
  CONSTRAINT fk_purchase_orders_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
  CONSTRAINT fk_purchase_orders_user FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE purchase_order_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  purchase_order_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  quantity_ordered DECIMAL(12,3) NOT NULL,
  quantity_received DECIMAL(12,3) NOT NULL DEFAULT 0,
  unit_cost DECIMAL(12,2) NOT NULL,
  CONSTRAINT uq_purchase_order_product UNIQUE (purchase_order_id, product_id),
  CONSTRAINT fk_purchase_items_order FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id),
  CONSTRAINT fk_purchase_items_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT chk_purchase_order_quantity CHECK (quantity_ordered > 0),
  CONSTRAINT chk_purchase_received CHECK (quantity_received >= 0 AND quantity_received <= quantity_ordered),
  CONSTRAINT chk_purchase_unit_cost CHECK (unit_cost >= 0)
) ENGINE=InnoDB;

CREATE TABLE goods_received_notes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  purchase_order_id BIGINT UNSIGNED NOT NULL,
  received_by BIGINT UNSIGNED NOT NULL,
  reference VARCHAR(80) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_grn_order FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id),
  CONSTRAINT fk_grn_user FOREIGN KEY (received_by) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE goods_received_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  grn_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  quantity DECIMAL(12,3) NOT NULL,
  unit_cost DECIMAL(12,2) NOT NULL,
  CONSTRAINT fk_grn_items_grn FOREIGN KEY (grn_id) REFERENCES goods_received_notes(id),
  CONSTRAINT fk_grn_items_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT chk_grn_item_quantity CHECK (quantity > 0)
) ENGINE=InnoDB;

CREATE TABLE customers (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(180) NOT NULL,
  phone VARCHAR(40) NULL,
  email VARCHAR(254) NULL,
  address VARCHAR(500) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_customers_name (name),
  INDEX idx_customers_phone (phone)
) ENGINE=InnoDB;

CREATE TABLE cashier_shifts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  branch_id BIGINT UNSIGNED NOT NULL,
  cashier_id BIGINT UNSIGNED NOT NULL,
  opening_cash DECIMAL(12,2) NOT NULL,
  closing_expected DECIMAL(12,2) NULL,
  closing_actual DECIMAL(12,2) NULL,
  status ENUM('open', 'closed') NOT NULL DEFAULT 'open',
  active_cashier_id BIGINT UNSIGNED GENERATED ALWAYS AS (CASE WHEN status = 'open' THEN cashier_id ELSE NULL END) STORED,
  opened_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at TIMESTAMP NULL,
  INDEX idx_cashier_shifts_open (branch_id, cashier_id, status),
  UNIQUE KEY uq_cashier_shifts_active (branch_id, active_cashier_id),
  CONSTRAINT fk_shifts_branch FOREIGN KEY (branch_id) REFERENCES branches(id),
  CONSTRAINT fk_shifts_cashier FOREIGN KEY (cashier_id) REFERENCES users(id),
  CONSTRAINT chk_shifts_opening_cash CHECK (opening_cash >= 0),
  CONSTRAINT chk_shifts_closing_cash CHECK (closing_actual IS NULL OR closing_actual >= 0)
) ENGINE=InnoDB;

ALTER TABLE sales
  ADD COLUMN customer_id BIGINT UNSIGNED NULL,
  ADD COLUMN shift_id BIGINT UNSIGNED NULL,
  ADD CONSTRAINT fk_sales_customer FOREIGN KEY (customer_id) REFERENCES customers(id),
  ADD CONSTRAINT fk_sales_shift FOREIGN KEY (shift_id) REFERENCES cashier_shifts(id);

CREATE TABLE cash_movements (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  shift_id BIGINT UNSIGNED NOT NULL,
  movement_type ENUM('deposit', 'withdrawal') NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  description VARCHAR(500) NOT NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_cash_movements_shift (shift_id, created_at),
  CONSTRAINT fk_cash_movements_shift FOREIGN KEY (shift_id) REFERENCES cashier_shifts(id),
  CONSTRAINT fk_cash_movements_user FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT chk_cash_movements_amount CHECK (amount > 0)
) ENGINE=InnoDB;

CREATE TABLE expense_categories (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE
) ENGINE=InnoDB;

CREATE TABLE expenses (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  branch_id BIGINT UNSIGNED NOT NULL,
  category_id BIGINT UNSIGNED NOT NULL,
  shift_id BIGINT UNSIGNED NULL,
  amount DECIMAL(12,2) NOT NULL,
  description VARCHAR(500) NOT NULL,
  payment_method ENUM('cash', 'mpesa', 'card', 'bank_transfer') NOT NULL,
  status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
  created_by BIGINT UNSIGNED NOT NULL,
  approved_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_expenses_branch_date (branch_id, created_at),
  CONSTRAINT fk_expenses_branch FOREIGN KEY (branch_id) REFERENCES branches(id),
  CONSTRAINT fk_expenses_category FOREIGN KEY (category_id) REFERENCES expense_categories(id),
  CONSTRAINT fk_expenses_shift FOREIGN KEY (shift_id) REFERENCES cashier_shifts(id),
  CONSTRAINT fk_expenses_user FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT fk_expenses_approver FOREIGN KEY (approved_by) REFERENCES users(id),
  CONSTRAINT chk_expenses_amount CHECK (amount > 0)
) ENGINE=InnoDB;

CREATE TABLE refunds (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  sale_id BIGINT UNSIGNED NOT NULL,
  branch_id BIGINT UNSIGNED NOT NULL,
  refund_number VARCHAR(40) NOT NULL UNIQUE,
  reason VARCHAR(500) NOT NULL,
  total DECIMAL(12,2) NOT NULL,
  status ENUM('completed', 'pending') NOT NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_refunds_branch_date (branch_id, created_at),
  CONSTRAINT fk_refunds_sale FOREIGN KEY (sale_id) REFERENCES sales(id),
  CONSTRAINT fk_refunds_branch FOREIGN KEY (branch_id) REFERENCES branches(id),
  CONSTRAINT fk_refunds_user FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT chk_refunds_total CHECK (total > 0)
) ENGINE=InnoDB;

CREATE TABLE refund_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  refund_id BIGINT UNSIGNED NOT NULL,
  sale_item_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  quantity DECIMAL(12,3) NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  CONSTRAINT fk_refund_items_refund FOREIGN KEY (refund_id) REFERENCES refunds(id),
  CONSTRAINT fk_refund_items_sale_item FOREIGN KEY (sale_item_id) REFERENCES sale_items(id),
  CONSTRAINT fk_refund_items_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT chk_refund_items_quantity CHECK (quantity > 0)
) ENGINE=InnoDB;

INSERT IGNORE INTO expense_categories (name) VALUES
  ('Utilities'), ('Transport'), ('Supplies'), ('Repairs'), ('Other');
