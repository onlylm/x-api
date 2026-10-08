ALTER TABLE orders ADD COLUMN payment_card_selection TEXT;
CREATE TRIGGER immutable_order_payment_selection BEFORE UPDATE OF payment_card_selection ON orders
WHEN NEW.payment_card_selection IS NOT OLD.payment_card_selection
BEGIN SELECT RAISE(ABORT,'immutable_order_payment_selection'); END;
