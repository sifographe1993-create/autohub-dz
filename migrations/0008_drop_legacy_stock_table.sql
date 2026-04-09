-- Remove legacy size-based stock table.
-- Advanced inventory now uses stock_items / stock_movements.

DROP TABLE IF EXISTS stock;
