-- Add explicit source column to ucf_commentary_clips so the frontend
-- knows whether a clip is a pre-generated fighter voice clip or a
-- dynamically generated commentary line. Defaults to 'dynamic' for
-- any existing rows (they were all dynamically generated).
ALTER TABLE ucf_commentary_clips
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'dynamic'
  CHECK (source IN ('pregen', 'dynamic'));
