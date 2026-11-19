ALTER TABLE users
  ADD COLUMN pos_username VARCHAR(100) NULL,
  ADD COLUMN pos_failed_attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN pos_locked_until DATETIME NULL,
  ADD UNIQUE KEY uq_users_pos_username (pos_username);

UPDATE users
SET pos_username = LOWER(SUBSTRING_INDEX(email, '@', 1))
WHERE pos_username IS NULL;

CREATE TABLE pos_sessions (
  id CHAR(36) NOT NULL PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_pos_sessions_user_expiry (user_id, expires_at),
  CONSTRAINT fk_pos_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;
