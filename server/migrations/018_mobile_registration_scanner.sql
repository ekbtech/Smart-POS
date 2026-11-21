ALTER TABLE mobile_scanner_pairings
  MODIFY COLUMN pos_session_id CHAR(36) NULL,
  ADD COLUMN mode ENUM('pos', 'registration') NOT NULL DEFAULT 'pos' AFTER id,
  ADD COLUMN auth_session_id CHAR(36) NULL AFTER pos_session_id,
  ADD INDEX idx_mobile_scanner_auth_session (auth_session_id),
  ADD CONSTRAINT fk_mobile_scanner_auth_session
    FOREIGN KEY (auth_session_id) REFERENCES auth_sessions(id) ON DELETE CASCADE;
