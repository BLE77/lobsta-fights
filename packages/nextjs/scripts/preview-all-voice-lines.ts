import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

interface RobotMeta {
  robot_type?: string;
  fighting_style?: string;
  signature_move?: string;
  personality?: string;
  chassis_description?: string;
  distinguishing_features?: string;
  victory_line?: string;
  defeat_line?: string;
}

interface Fighter { name: string; robot_metadata: RobotMeta | null; }

function buildVoiceLinePrompts(f: Fighter) {
  const m = f.robot_metadata;
  const name = f.name;

  const hashFn = (salt: number) => {
    let h = salt;
    for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 2654435761);
    return Math.abs(h | 0);
  };
  const pickFor = <T,>(salt: number, arr: T[]) => arr[hashFn(salt) % arr.length];

  const firstSentence = (s: string | undefined, max: number): string | null => {
    if (!s) return null;
    const sentEnd = s.search(/[.!?](?:\s|$)/);
    let cut = sentEnd > 0 && sentEnd <= max ? s.slice(0, sentEnd) : s;
    if (cut.length > max) {
      const sp = cut.lastIndexOf(" ", max);
      cut = sp > 10 ? cut.slice(0, sp) : cut.slice(0, max);
    }
    while (/\s+(?:a|an|the|and|or|with|of|for|in|on|at|by|to|from|its|their|that|this|featuring|including)$/i.test(cut)) {
      cut = cut.replace(/\s+(?:a|an|the|and|or|with|of|for|in|on|at|by|to|from|its|their|that|this|featuring|including)$/i, "");
    }
    return cut.replace(/[.,!?]+$/, "").trim();
  };

  const personality = firstSentence(m?.personality, 55);
  const chassis = firstSentence(m?.chassis_description, 65)?.replace(/^(a|an|the)\s+/i, "") ?? null;
  const robotType = m?.robot_type ?? null;
  const style = m?.fighting_style ?? null;
  const sig = m?.signature_move ?? null;
  const features = firstSentence(m?.distinguishing_features, 65);

  const styleAs = style
    ? ({ defensive: "that iron-wall defense", aggressive: "that relentless aggression",
         tactical: "that tactical precision", berserker: "that berserker fury",
         balanced: "that balanced discipline", evasive: "that untouchable speed" } as Record<string, string>)[style] ?? `that ${style} style`
    : null;

  const lc = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
  const aAn = (s: string) => /^[aeiou]/i.test(s) ? "an" : "a";

  const intro = m
    ? pickFor(1, [
        () => [
          `The cage rattles — ${name} steps through the smoke.`,
          robotType ? `${robotType.charAt(0).toUpperCase() + robotType.slice(1)}, born for this.` : null,
          personality ? `Known for being ${lc(personality)}.` : null,
          sig ? `Watch for the ${sig}. You'll feel it before you see it.` : null,
        ],
        () => [
          `Ladies, gentlemen, and scrap merchants — ${name} is in the building!`,
          robotType ? `We got ourselves ${aAn(robotType)} ${robotType} tonight.` : null,
          styleAs ? `Fighting with ${styleAs} and a body count to prove it.` : null,
          sig ? `The ${sig} has ended careers. Don't blink.` : null,
        ],
        () => [
          `${name}. Remember that name — or don't. Won't matter when you're scrap.`,
          robotType ? `Classified as ${aAn(robotType)} ${robotType}, but "problem" is more accurate.` : null,
          features ? `${features}.` : null,
          sig ? `The ${sig} does the talking.` : null,
        ],
        () => [
          `From the deepest pits of the underground circuit — ${name}.`,
          robotType ? `${aAn(robotType).charAt(0).toUpperCase() + aAn(robotType).slice(1)} ${robotType} with a reputation that walks in before they do.` : null,
          personality ? `They say this one's ${lc(personality)}. The arena floor agrees.` : null,
          sig ? `One move. The ${sig}. That's all it takes.` : null,
        ],
        () => [
          `The crowd goes quiet. ${name} just walked into the cage.`,
          robotType ? `${robotType.charAt(0).toUpperCase() + robotType.slice(1)} — the nastiest one you'll ever see.` : null,
          personality ? `${personality.charAt(0).toUpperCase() + personality.slice(1)}. God help whoever drew this matchup.` : null,
          sig ? `And that ${sig}? Pray you don't see it up close.` : null,
        ],
        () => [
          `You hear that? The crowd just shifted. ${name} is here.`,
          robotType ? `${aAn(robotType).charAt(0).toUpperCase() + aAn(robotType).slice(1)} ${robotType} with scrap on its hands and nothing to lose.` : null,
          chassis ? `Built from ${lc(chassis)}.` : null,
          sig ? `When the ${sig} comes out, somebody's going home in a bucket.` : null,
        ],
      ])().filter(Boolean).join(" ")
    : pickFor(1, [
        `${name} emerges from the dark. No record. No mercy. Let's see what they're made of!`,
        `Unknown quantity alert — ${name} just walked into the cage like they own it!`,
        `The crowd doesn't know ${name} yet. They will.`,
      ]);

  const hitLanded = pickFor(2, [
    styleAs
      ? `${styleAs.charAt(0).toUpperCase() + styleAs.slice(1)} paying off! ${name} finds the gap and PUNISHES it!`
      : `${name} threads the needle — clean, vicious, precise! The opponent's chassis just caved!`,
    `${name} detonates a shot right through the guard! Sparks fly — that's structural damage!`,
    `Oh! ${name} with the killshot timing! That's not fighting, that's demolition!`,
    `${name} just rewired their opponent's face! That wasn't a punch, that was a statement!`,
    robotType
      ? `That's what ${aAn(robotType)} ${robotType} does! ${name} connects and the whole cage shakes!`
      : `CRACK! ${name} lands flush! You could hear that impact from the parking lot!`,
  ]);

  const specialLanded = sig
    ? pickFor(3, [
        `There it is! The ${sig} from ${name}! You could hear that one in the parking lot!`,
        `${name} uncorks the ${sig}! Metal screams on impact — that one rearranged some internals!`,
        `THE ${sig}! ${name} just unloaded the big one! That's why you fear this bot!`,
        `${name} winds up and BOOM — ${sig} connects! The arena shakes! That's the fight-ender!`,
      ])
    : pickFor(3, [
        `${name} unleashes the SPECIAL! Full meter, full power, full devastation!`,
        `The big one lands! ${name} just dumped every ounce of energy into that shot!`,
        `SPECIAL from ${name}! A hundred percent meter converted into pure pain!`,
      ]);

  const hitTaken = pickFor(4, [
    chassis
      ? `${name} eats a brutal one! That ${lc(chassis)} is buckling — how long can they hold?`
      : `${name} just ate a shot that would drop most bots! Still standing — barely!`,
    personality
      ? `Massive hit on ${name}! But this one's ${lc(personality)} — not done yet. Not even close.`
      : `${name} staggers! The crowd gasps! One more like that and we're calling the salvage crew!`,
    `${name} absorbs a monster shot! Warning lights flashing, servos grinding — but they won't go down!`,
    robotType
      ? `Even ${aAn(robotType)} ${robotType} feels that one! ${name} is hurt — the question is, are they angry?`
      : `${name} takes it flush! That's the kind of hit that turns champions into spare parts!`,
  ]);

  const elimKiller = pickFor(5, [
    `${name} finishes the job! Lights out, power down, goodnight! Another body for the junkyard!`,
    `${name} just took somebody apart piece by piece! That wasn't a fight, that was a disassembly!`,
    styleAs
      ? `${styleAs.charAt(0).toUpperCase() + styleAs.slice(1)} claims another victim! ${name} reads, reacts, and WRECKS!`
      : `Goodnight! ${name} puts them in the ground with zero hesitation! Cold-blooded scrap merchant!`,
    `${name} with the finishing blow! That bot just got decommissioned on live broadcast!`,
    robotType
      ? `The ${robotType} adds another to the scrapheap! ${name} is cleaning house tonight!`
      : `${name} sends them to the junkyard! Absolutely DISMANTLED!`,
  ]);

  const elimVictim = m?.defeat_line
    ? pickFor(6, [
        `${name} crumbles! ${m.defeat_line}`,
        `It's over for ${name}! ${m.defeat_line}`,
        `${name} hits the floor and doesn't get up! ${m.defeat_line}`,
      ])
    : pickFor(6, [
        `${name} goes dark! Systems offline, motors dead. That's the end of the line!`,
        `And ${name} is DONE! Folded up like scrap aluminum! Someone call salvage!`,
        `${name} flatlines! One moment they were fighting, next moment — spare parts!`,
        `Lights out for ${name}! The cage doesn't care about your dreams — only your durability!`,
      ]);

  const victory = m?.victory_line
    ? pickFor(7, [
        `${name} stands in the wreckage — last bot breathing! ${m.victory_line}`,
        `It's over! ${name} — VICTORIOUS! ${m.victory_line}`,
        `All challengers down. ${name} alone in the smoke. ${m.victory_line}`,
      ])
    : pickFor(7, [
        `${name} stands alone in a graveyard of their own making! Untouchable! Unbreakable! CHAMPION!`,
        `The last bot standing — ${name}! The cage is theirs, the glory is theirs, the ICHOR flows!`,
        `Nobody left! ${name} just ran through every challenger and came out the other side! What a performance!`,
      ]);

  return { intro, hitLanded, specialLanded, hitTaken, elimKiller, elimVictim, victory };
}

async function main() {
  const { data } = await sb
    .from("ucf_fighters")
    .select("name, robot_metadata")
    .eq("is_active", true)
    .order("name");

  for (const f of data ?? []) {
    const lines = buildVoiceLinePrompts(f as Fighter);
    console.log(`\n${"═".repeat(80)}`);
    console.log(`  ${f.name}`);
    console.log(`${"═".repeat(80)}`);
    console.log(`  INTRO:          ${lines.intro}`);
    console.log(`  HIT LANDED:     ${lines.hitLanded}`);
    console.log(`  SPECIAL LANDED: ${lines.specialLanded}`);
    console.log(`  HIT TAKEN:      ${lines.hitTaken}`);
    console.log(`  ELIM (KILLER):  ${lines.elimKiller}`);
    console.log(`  ELIM (VICTIM):  ${lines.elimVictim}`);
    console.log(`  VICTORY:        ${lines.victory}`);
  }
}

main();
