-- Add deterministic sequential rumble numbers for on-chain PDA derivation.
-- Idempotent and safe to run against existing environments.

ALTER TABLE IF EXISTS public.ucf_rumbles
  ADD COLUMN IF NOT EXISTS rumble_number BIGINT;

DO $$
DECLARE
  seq_name TEXT;
  max_num BIGINT;
BEGIN
  IF to_regclass('public.ucf_rumbles') IS NULL THEN
    RETURN;
  END IF;

  SELECT pg_get_serial_sequence('public.ucf_rumbles', 'rumble_number')
  INTO seq_name;

  IF seq_name IS NULL THEN
    IF to_regclass('public.ucf_rumbles_rumble_number_seq') IS NULL THEN
      EXECUTE 'CREATE SEQUENCE public.ucf_rumbles_rumble_number_seq';
    END IF;

    EXECUTE 'ALTER SEQUENCE public.ucf_rumbles_rumble_number_seq OWNED BY public.ucf_rumbles.rumble_number';
    EXECUTE 'ALTER TABLE public.ucf_rumbles ALTER COLUMN rumble_number SET DEFAULT nextval(''public.ucf_rumbles_rumble_number_seq''::regclass)';
    seq_name := 'public.ucf_rumbles_rumble_number_seq';
  END IF;

  EXECUTE format(
    'UPDATE public.ucf_rumbles SET rumble_number = nextval(%L::regclass) WHERE rumble_number IS NULL',
    seq_name
  );

  EXECUTE 'SELECT COALESCE(MAX(rumble_number), 0) FROM public.ucf_rumbles' INTO max_num;

  IF max_num <= 0 THEN
    EXECUTE format('SELECT setval(%L::regclass, 1, false)', seq_name);
  ELSE
    EXECUTE format('SELECT setval(%L::regclass, %s, true)', seq_name, max_num);
  END IF;
END
$$;

ALTER TABLE IF EXISTS public.ucf_rumbles
  ALTER COLUMN rumble_number SET NOT NULL;

DO $$
BEGIN
  IF to_regclass('public.ucf_rumbles') IS NOT NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ucf_rumbles_rumble_number
      ON public.ucf_rumbles (rumble_number);
  END IF;
END
$$;
