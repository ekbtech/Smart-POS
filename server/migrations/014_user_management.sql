ALTER TABLE employees
  ADD COLUMN employee_number VARCHAR(50) NULL,
  ADD UNIQUE KEY uq_employees_employee_number (employee_number);

UPDATE users
SET username = LOWER(SUBSTRING_INDEX(email, '@', 1))
WHERE username IS NULL;

UPDATE users
SET pos_username = username
WHERE pos_username IS NULL;
