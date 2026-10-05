-- Preserve existing customer records and the unique phone constraint while
-- aligning the redesigned schema with the column used by the chat service.
DO $$
DECLARE
  target_schema TEXT := current_schema();
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = target_schema
      AND table_name = 'customers'
      AND column_name = 'phone_number'
  ) AND EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = target_schema
      AND table_name = 'customers'
      AND column_name = 'phone'
  ) THEN
    EXECUTE format(
      'ALTER TABLE %I.customers RENAME COLUMN phone TO phone_number',
      target_schema
    );
  END IF;
END;
$$;
