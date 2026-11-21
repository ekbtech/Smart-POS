CREATE TABLE mobile_scanner_pairings (
  id CHAR(36) NOT NULL PRIMARY KEY,
  pos_session_id CHAR(36) NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  branch_id BIGINT UNSIGNED NOT NULL,
  pair_token_hash CHAR(64) NULL,
  scanner_token_hash CHAR(64) NULL,
  pair_expires_at DATETIME(3) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  last_scanner_seen_at DATETIME(3) NULL,
  last_pos_seen_at DATETIME(3) NOT NULL,
  last_barcode VARCHAR(64) NULL,
  last_barcode_at DATETIME(3) NULL,
  latest_result JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_mobile_scanner_pos_session (pos_session_id),
  INDEX idx_mobile_scanner_expiry (expires_at),
  CONSTRAINT fk_mobile_scanner_pos_session
    FOREIGN KEY (pos_session_id) REFERENCES pos_sessions(id) ON DELETE CASCADE,
  CONSTRAINT fk_mobile_scanner_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_mobile_scanner_branch
    FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE mobile_scanner_scans (
  id CHAR(36) NOT NULL PRIMARY KEY,
  pairing_id CHAR(36) NOT NULL,
  barcode VARCHAR(64) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  processed_at DATETIME(3) NULL,
  result JSON NULL,
  INDEX idx_mobile_scanner_pending (pairing_id, processed_at, created_at),
  CONSTRAINT fk_mobile_scanner_scan_pairing
    FOREIGN KEY (pairing_id) REFERENCES mobile_scanner_pairings(id) ON DELETE CASCADE
) ENGINE=InnoDB;
