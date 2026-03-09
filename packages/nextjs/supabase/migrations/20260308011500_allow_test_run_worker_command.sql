DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'worker_commands'
  ) THEN
    ALTER TABLE public.worker_commands
      DROP CONSTRAINT IF EXISTS worker_commands_command_check;

    ALTER TABLE public.worker_commands
      ADD CONSTRAINT worker_commands_command_check
      CHECK (
        command = ANY (
          ARRAY[
            'start_bots'::text,
            'stop_bots'::text,
            'set_bot_target'::text,
            'restart_bots'::text,
            'clear_bot_target'::text,
            'test_run'::text
          ]
        )
      );
  END IF;
END
$$;
