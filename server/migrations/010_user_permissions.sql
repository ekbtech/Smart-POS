ALTER TABLE users
  ADD COLUMN username VARCHAR(100) NULL AFTER pos_username,
  ADD COLUMN default_landing VARCHAR(80) NULL,
  ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN main_failed_attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN main_locked_until DATETIME NULL,
  ADD UNIQUE KEY uq_users_username (username);

UPDATE users u
SET u.username = COALESCE(u.pos_username, LOWER(SUBSTRING_INDEX(u.email, '@', 1)))
WHERE u.username IS NULL;

CREATE TABLE modules (
  id VARCHAR(40) NOT NULL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  route VARCHAR(160) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0
) ENGINE=InnoDB;

INSERT INTO modules (id, name, route, sort_order) VALUES
  ('dashboard','Dashboard','/',10),
  ('pos','POS / Checkout','/pos',20),
  ('sales','Sales History','/sales',30),
  ('products','Products','/products',40),
  ('inventory','Inventory','/inventory',50),
  ('purchases','Purchasing','/purchases',60),
  ('suppliers','Suppliers','/suppliers',70),
  ('customers','Customers','/customers',80),
  ('employees','Employees','/staff',90),
  ('expenses','Expenses','/expenses',100),
  ('shifts','Cashier Shifts','/shifts',110),
  ('reports','Reports','/reports',120),
  ('permissions','User Management','/staff',130),
  ('settings','Settings','/staff',140),
  ('audit','Audit Logs','/staff',150);

CREATE TABLE role_permissions (
  role_id BIGINT UNSIGNED NOT NULL,
  module_id VARCHAR(40) NOT NULL,
  allowed BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (role_id, module_id),
  CONSTRAINT fk_role_permissions_role FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
  CONSTRAINT fk_role_permissions_module FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE user_permissions (
  user_id BIGINT UNSIGNED NOT NULL,
  module_id VARCHAR(40) NOT NULL,
  allowed BOOLEAN NOT NULL,
  PRIMARY KEY (user_id, module_id),
  CONSTRAINT fk_user_permissions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_user_permissions_module FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE CASCADE
) ENGINE=InnoDB;

INSERT INTO role_permissions (role_id, module_id, allowed)
SELECT r.id, m.id, TRUE
FROM roles r CROSS JOIN modules m
WHERE r.name='admin';

INSERT INTO role_permissions (role_id, module_id, allowed)
SELECT r.id, m.id, TRUE
FROM roles r CROSS JOIN modules m
WHERE r.name='manager'
  AND m.id IN ('dashboard','pos','sales','products','inventory','purchases','suppliers','customers','employees','expenses','shifts','reports');

INSERT INTO role_permissions (role_id, module_id, allowed)
SELECT r.id, m.id, TRUE
FROM roles r CROSS JOIN modules m
WHERE r.name='cashier'
  AND m.id IN ('pos','sales','customers','shifts');

INSERT INTO role_permissions (role_id, module_id, allowed)
SELECT r.id, m.id, TRUE
FROM roles r CROSS JOIN modules m
WHERE r.name='inventory_manager'
  AND m.id IN ('dashboard','products','inventory','purchases','suppliers','reports');

INSERT INTO role_permissions (role_id, module_id, allowed)
SELECT r.id, m.id, TRUE
FROM roles r CROSS JOIN modules m
WHERE r.name='procurement_officer'
  AND m.id IN ('dashboard','purchases','suppliers','inventory','reports');

INSERT INTO role_permissions (role_id, module_id, allowed)
SELECT r.id, m.id, TRUE
FROM roles r CROSS JOIN modules m
WHERE r.name='accountant'
  AND m.id IN ('dashboard','sales','expenses','reports','purchases');

UPDATE users u
JOIN user_roles ur ON ur.user_id=u.id
JOIN roles r ON r.id=ur.role_id
SET u.default_landing=CASE r.name
  WHEN 'cashier' THEN '/pos'
  WHEN 'inventory_manager' THEN '/inventory'
  WHEN 'procurement_officer' THEN '/purchases'
  WHEN 'accountant' THEN '/reports'
  WHEN 'manager' THEN '/'
  ELSE '/'
END
WHERE u.default_landing IS NULL;

CREATE TABLE login_history (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NULL,
  identifier VARCHAR(254) NULL,
  success BOOLEAN NOT NULL,
  ip_address VARCHAR(45) NULL,
  user_agent VARCHAR(500) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_login_history_user_date (user_id, created_at),
  CONSTRAINT fk_login_history_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;
