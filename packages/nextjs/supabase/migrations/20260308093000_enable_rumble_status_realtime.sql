-- Enable Realtime notifications for public rumble status tables.
-- The public status API already exposes queue/rumble/jackpot data, so the
-- anon client needs SELECT visibility here in order to receive Realtime events.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'ucf_rumble_queue'
      AND policyname = 'anon_read_queue'
  ) THEN
    CREATE POLICY "anon_read_queue" ON public.ucf_rumble_queue
      FOR SELECT TO anon USING (true);
  END IF;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.ucf_rumbles;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.ucf_rumble_queue;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.ucf_ichor_shower;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
