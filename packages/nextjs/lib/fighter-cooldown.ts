import { freshSupabase } from "./supabase";

/**
 * Fighter cooldown: 45 minutes between fights.
 * Checks if a fighter has completed a match within the cooldown window.
 * Returns { on_cooldown: false } or { on_cooldown: true, cooldown_ends, minutes_remaining }.
 */

const COOLDOWN_MINUTES = 45;

export async function checkFighterCooldown(fighterId: string): Promise<{
  on_cooldown: boolean;
  cooldown_ends?: string;
  minutes_remaining?: number;
}> {
  const supabase = freshSupabase();

  const { data: lastMatch, error } = await supabase
    .from("ucf_matches")
    .select("finished_at")
    .eq("state", "FINISHED")
    .or(`fighter_a_id.eq.${fighterId},fighter_b_id.eq.${fighterId}`)
    .not("finished_at", "is", null)
    .order("finished_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !lastMatch || !lastMatch.finished_at) {
    return { on_cooldown: false };
  }

  const finishedAt = new Date(lastMatch.finished_at).getTime();
  const cooldownEnds = finishedAt + COOLDOWN_MINUTES * 60 * 1000;
  const now = Date.now();

  if (now < cooldownEnds) {
    const minutesRemaining = Math.ceil((cooldownEnds - now) / 60_000);
    return {
      on_cooldown: true,
      cooldown_ends: new Date(cooldownEnds).toISOString(),
      minutes_remaining: minutesRemaining,
    };
  }

  return { on_cooldown: false };
}
