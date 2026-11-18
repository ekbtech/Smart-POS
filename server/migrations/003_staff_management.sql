CREATE TABLE departments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

INSERT IGNORE INTO departments (name) VALUES
  ('General'), ('Cashiers'), ('Inventory'), ('Procurement'), ('Finance');

INSERT IGNORE INTO roles (name) VALUES
  ('admin'), ('manager'), ('cashier'), ('inventory_manager'), ('procurement_officer'), ('accountant');

CREATE TABLE employees (
  user_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  department_id BIGINT UNSIGNED NULL,
  job_title VARCHAR(120) NULL,
  phone VARCHAR(40) NULL,
  hired_at DATE NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_employees_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_employees_department FOREIGN KEY (department_id) REFERENCES departments(id)
) ENGINE=InnoDB;
