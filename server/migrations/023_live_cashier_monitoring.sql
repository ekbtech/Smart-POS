ALTER TABLE cashier_shifts
  ADD COLUMN counter_number VARCHAR(40) NULL AFTER cashier_id;

ALTER TABLE pos_sessions
  ADD COLUMN last_activity_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER last_used_at;

ALTER TABLE users
  ADD COLUMN last_pos_login_at DATETIME NULL,
  ADD COLUMN last_pos_activity_at DATETIME NULL;

INSERT INTO modules (id, name, route, sort_order) VALUES
  ('cashier_monitoring', 'Live Cashier Monitoring', '/cashier-monitor', 21)
ON DUPLICATE KEY UPDATE name=VALUES(name), route=VALUES(route), sort_order=VALUES(sort_order);

INSERT INTO role_permissions (role_id, module_id, allowed)
SELECT r.id, 'cashier_monitoring', TRUE
FROM roles r
WHERE r.name IN ('admin', 'manager')
ON DUPLICATE KEY UPDATE allowed=TRUE;
