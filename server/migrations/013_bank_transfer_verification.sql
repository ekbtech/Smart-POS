CREATE TABLE IF NOT EXISTS bank_transfer_verifications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  branch_id BIGINT UNSIGNED NOT NULL,
  cashier_id BIGINT UNSIGNED NOT NULL,
  reference VARCHAR(100) NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  status ENUM('pending', 'verified', 'rejected', 'used') NOT NULL DEFAULT 'pending',
  reviewed_by BIGINT UNSIGNED NULL,
  sale_id BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  verified_at DATETIME NULL,
  UNIQUE KEY uq_bank_transfer_branch_reference (branch_id, reference),
  INDEX idx_bank_transfer_status (branch_id, status, created_at),
  CONSTRAINT fk_bank_transfer_branch FOREIGN KEY (branch_id) REFERENCES branches(id),
  CONSTRAINT fk_bank_transfer_cashier FOREIGN KEY (cashier_id) REFERENCES users(id),
  CONSTRAINT fk_bank_transfer_reviewer FOREIGN KEY (reviewed_by) REFERENCES users(id),
  CONSTRAINT fk_bank_transfer_sale FOREIGN KEY (sale_id) REFERENCES sales(id),
  CONSTRAINT chk_bank_transfer_amount CHECK (amount > 0)
) ENGINE=InnoDB;
