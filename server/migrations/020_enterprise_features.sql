ALTER TABLE branches
  ADD COLUMN address VARCHAR(500) NULL AFTER code,
  ADD COLUMN phone VARCHAR(40) NULL AFTER address,
  ADD COLUMN email VARCHAR(254) NULL AFTER phone,
  ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE AFTER allow_negative_stock,
  ADD COLUMN timezone VARCHAR(64) NOT NULL DEFAULT 'Africa/Nairobi';

CREATE TABLE branch_assignments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  branch_id BIGINT UNSIGNED NOT NULL,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_branch_assignment (user_id, branch_id),
  CONSTRAINT fk_branch_assignments_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_branch_assignments_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE
) ENGINE=InnoDB;

INSERT INTO branch_assignments (user_id, branch_id, is_primary)
SELECT id, branch_id, TRUE FROM users
ON DUPLICATE KEY UPDATE is_primary = TRUE;

CREATE TABLE product_price_history (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT UNSIGNED NOT NULL,
  branch_id BIGINT UNSIGNED NULL,
  changed_by BIGINT UNSIGNED NULL,
  previous_buying_price DECIMAL(12,2) NULL,
  new_buying_price DECIMAL(12,2) NULL,
  previous_selling_price DECIMAL(12,2) NULL,
  new_selling_price DECIMAL(12,2) NULL,
  reason VARCHAR(500) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_price_history_product_date (product_id, created_at),
  INDEX idx_price_history_branch_date (branch_id, created_at),
  CONSTRAINT fk_price_history_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT fk_price_history_branch FOREIGN KEY (branch_id) REFERENCES branches(id),
  CONSTRAINT fk_price_history_user FOREIGN KEY (changed_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE offline_sale_sync (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  offline_id CHAR(36) NOT NULL,
  branch_id BIGINT UNSIGNED NOT NULL,
  cashier_id BIGINT UNSIGNED NOT NULL,
  status ENUM('pending', 'syncing', 'synced', 'failed') NOT NULL DEFAULT 'pending',
  sale_id BIGINT UNSIGNED NULL,
  receipt_number VARCHAR(40) NULL,
  payload JSON NOT NULL,
  error_message VARCHAR(1000) NULL,
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  synced_at TIMESTAMP NULL,
  UNIQUE KEY uq_offline_sale_id (branch_id, offline_id),
  INDEX idx_offline_sync_status (status, created_at),
  CONSTRAINT fk_offline_sync_branch FOREIGN KEY (branch_id) REFERENCES branches(id),
  CONSTRAINT fk_offline_sync_cashier FOREIGN KEY (cashier_id) REFERENCES users(id),
  CONSTRAINT fk_offline_sync_sale FOREIGN KEY (sale_id) REFERENCES sales(id)
) ENGINE=InnoDB;

CREATE TABLE backup_settings (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  frequency ENUM('daily', 'weekly', 'monthly') NOT NULL DEFAULT 'daily',
  retention_count INT UNSIGNED NOT NULL DEFAULT 30,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  encrypted BOOLEAN NOT NULL DEFAULT TRUE,
  destination VARCHAR(500) NULL,
  updated_by BIGINT UNSIGNED NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_backup_settings_user FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

INSERT INTO backup_settings (id, frequency, retention_count, enabled, encrypted)
VALUES (1, 'daily', 30, FALSE, TRUE);

CREATE TABLE database_backups (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  filename VARCHAR(255) NOT NULL,
  storage_location VARCHAR(1000) NOT NULL,
  checksum_sha256 CHAR(64) NOT NULL,
  encrypted BOOLEAN NOT NULL DEFAULT TRUE,
  status ENUM('created', 'failed', 'verified', 'restored') NOT NULL,
  size_bytes BIGINT UNSIGNED NULL,
  error_message VARCHAR(1000) NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  verified_at TIMESTAMP NULL,
  INDEX idx_database_backups_created (created_at),
  CONSTRAINT fk_database_backups_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE notification_settings (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  provider VARCHAR(40) NOT NULL DEFAULT 'whatsapp',
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  daily_summary_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  low_stock_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  receipt_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by BIGINT UNSIGNED NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_notification_settings_user FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

INSERT INTO notification_settings (id, enabled) VALUES (1, FALSE);

CREATE TABLE notification_templates (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  template_key VARCHAR(80) NOT NULL UNIQUE,
  provider_template_name VARCHAR(160) NULL,
  language VARCHAR(20) NOT NULL DEFAULT 'en',
  subject VARCHAR(160) NULL,
  body TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE notifications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  branch_id BIGINT UNSIGNED NULL,
  customer_id BIGINT UNSIGNED NULL,
  sale_id BIGINT UNSIGNED NULL,
  provider VARCHAR(40) NOT NULL DEFAULT 'whatsapp',
  recipient VARCHAR(100) NOT NULL,
  template_key VARCHAR(80) NULL,
  provider_message_id VARCHAR(160) NULL,
  status ENUM('queued', 'sent', 'delivered', 'failed', 'cancelled') NOT NULL DEFAULT 'queued',
  payload JSON NULL,
  error_message VARCHAR(1000) NULL,
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_notifications_status_date (status, created_at),
  INDEX idx_notifications_recipient (recipient),
  CONSTRAINT fk_notifications_branch FOREIGN KEY (branch_id) REFERENCES branches(id),
  CONSTRAINT fk_notifications_customer FOREIGN KEY (customer_id) REFERENCES customers(id),
  CONSTRAINT fk_notifications_sale FOREIGN KEY (sale_id) REFERENCES sales(id)
) ENGINE=InnoDB;

CREATE TABLE electronic_receipts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  sale_id BIGINT UNSIGNED NOT NULL,
  branch_id BIGINT UNSIGNED NOT NULL,
  receipt_number VARCHAR(40) NOT NULL,
  pdf_storage_path VARCHAR(1000) NULL,
  pdf_sha256 CHAR(64) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_electronic_receipt_sale (sale_id),
  UNIQUE KEY uq_electronic_receipt_number (receipt_number),
  INDEX idx_electronic_receipts_branch_date (branch_id, created_at),
  CONSTRAINT fk_electronic_receipts_sale FOREIGN KEY (sale_id) REFERENCES sales(id),
  CONSTRAINT fk_electronic_receipts_branch FOREIGN KEY (branch_id) REFERENCES branches(id)
) ENGINE=InnoDB;

INSERT INTO modules (id, name, route, sort_order)
VALUES
  ('branches','Branch Management','/branches',13),
  ('sync_monitor','Offline Sync','/sync-monitor',14),
  ('backups','Database Backups','/backups',15),
  ('price_history','Price History','/price-history',16),
  ('notifications','Notification Centre','/notifications',17),
  ('receipts','Electronic Receipts','/receipts',18),
  ('comparisons','Business Comparisons','/comparisons',19)
ON DUPLICATE KEY UPDATE name=VALUES(name), route=VALUES(route), sort_order=VALUES(sort_order);

INSERT INTO role_permissions (role_id, module_id, allowed)
SELECT r.id, m.id, TRUE
FROM roles r CROSS JOIN modules m
WHERE r.name='admin'
  AND m.id IN ('branches','sync_monitor','backups','price_history','notifications','receipts','comparisons');

INSERT INTO role_permissions (role_id, module_id, allowed)
SELECT r.id, m.id, TRUE
FROM roles r CROSS JOIN modules m
WHERE r.name='manager'
  AND m.id IN ('branches','sync_monitor','price_history','notifications','receipts','comparisons');

INSERT INTO role_permissions (role_id, module_id, allowed)
SELECT r.id, m.id, TRUE
FROM roles r CROSS JOIN modules m
WHERE r.name='cashier'
  AND m.id IN ('receipts');
