-- Drop the trigger that prevented betting on multiple fighters per rumble.
-- The game design allows (and the UI supports) betting on any/all fighters.
DROP TRIGGER IF EXISTS trg_one_fighter_per_wallet_per_rumble ON ucf_bets;
DROP FUNCTION IF EXISTS check_one_fighter_per_wallet_per_rumble();
