ALTER TABLE users
  ADD COLUMN pos_password_hash VARCHAR(255) NULL AFTER pos_username;

UPDATE users
SET pos_password_hash = password_hash
WHERE pos_username IS NOT NULL;
