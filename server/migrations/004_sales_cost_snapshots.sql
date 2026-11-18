ALTER TABLE sale_items
  ADD COLUMN net_total DECIMAL(12,2) NULL AFTER line_total,
  ADD COLUMN tax_amount DECIMAL(12,2) NULL AFTER net_total,
  ADD COLUMN unit_cost_snapshot DECIMAL(12,2) NULL AFTER tax_amount;

UPDATE sale_items
SET net_total = ROUND(line_total / (1 + tax_rate / 100), 2),
    tax_amount = line_total - ROUND(line_total / (1 + tax_rate / 100), 2);

ALTER TABLE refund_items
  ADD COLUMN net_amount DECIMAL(12,2) NULL AFTER amount;

UPDATE refund_items ri
JOIN sale_items si ON si.id = ri.sale_item_id
SET ri.net_amount = ROUND(ri.amount / (1 + si.tax_rate / 100), 2);
