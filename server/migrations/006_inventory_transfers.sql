CREATE TABLE inventory_transfers (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  reference VARCHAR(40) NOT NULL UNIQUE,
  source_branch_id BIGINT UNSIGNED NOT NULL,
  destination_branch_id BIGINT UNSIGNED NOT NULL,
  notes VARCHAR(500) NULL,
  status ENUM('draft', 'in_transit', 'received', 'cancelled') NOT NULL DEFAULT 'draft',
  created_by BIGINT UNSIGNED NOT NULL,
  dispatched_by BIGINT UNSIGNED NULL,
  received_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  dispatched_at TIMESTAMP NULL,
  received_at TIMESTAMP NULL,
  INDEX idx_inventory_transfers_source (source_branch_id, created_at),
  INDEX idx_inventory_transfers_destination (destination_branch_id, created_at),
  CONSTRAINT fk_inventory_transfers_source FOREIGN KEY (source_branch_id) REFERENCES branches(id),
  CONSTRAINT fk_inventory_transfers_destination FOREIGN KEY (destination_branch_id) REFERENCES branches(id),
  CONSTRAINT fk_inventory_transfers_creator FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT fk_inventory_transfers_dispatcher FOREIGN KEY (dispatched_by) REFERENCES users(id),
  CONSTRAINT fk_inventory_transfers_receiver FOREIGN KEY (received_by) REFERENCES users(id),
  CONSTRAINT chk_inventory_transfers_distinct_branches CHECK (source_branch_id <> destination_branch_id)
) ENGINE=InnoDB;

CREATE TABLE inventory_transfer_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  transfer_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  quantity_requested DECIMAL(12,3) NOT NULL,
  quantity_dispatched DECIMAL(12,3) NULL,
  quantity_received DECIMAL(12,3) NULL,
  quantity_variance DECIMAL(12,3) NULL,
  UNIQUE KEY uq_inventory_transfer_product (transfer_id, product_id),
  CONSTRAINT fk_inventory_transfer_items_transfer FOREIGN KEY (transfer_id) REFERENCES inventory_transfers(id),
  CONSTRAINT fk_inventory_transfer_items_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT chk_inventory_transfer_items_quantity CHECK (quantity_requested > 0)
) ENGINE=InnoDB;

CREATE TABLE inventory_transfer_batches (
  transfer_item_id BIGINT UNSIGNED NOT NULL,
  source_batch_id BIGINT UNSIGNED NOT NULL,
  batch_code VARCHAR(80) NULL,
  expiry_date DATE NULL,
  unit_cost DECIMAL(12,2) NULL,
  quantity_dispatched DECIMAL(12,3) NOT NULL,
  PRIMARY KEY (transfer_item_id, source_batch_id),
  CONSTRAINT fk_inventory_transfer_batches_item FOREIGN KEY (transfer_item_id) REFERENCES inventory_transfer_items(id),
  CONSTRAINT fk_inventory_transfer_batches_source FOREIGN KEY (source_batch_id) REFERENCES inventory_batches(id),
  CONSTRAINT chk_inventory_transfer_batches_quantity CHECK (quantity_dispatched > 0)
) ENGINE=InnoDB;
