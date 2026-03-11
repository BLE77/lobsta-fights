/**
 * DamageNumberManager — Overlay container that manages active floating damage numbers.
 * Renders as an absolute overlay with pointerEvents="none" so it doesn't block interaction.
 */

import React, { useCallback, useRef, useState } from "react";
import { View, type ViewStyle } from "react-native";
import { DamageNumber, type DamageNumberEntry } from "./DamageNumber";

const MAX_PER_FIGHTER = 4;
const MAX_TOTAL = 10;
const STACK_OFFSET_Y = 28;
const JITTER_RANGE = 24; // -12 to +12

let nextId = 0;

const PAIR_ROW_HEIGHT = 120;

export type SpawnDamageNumberArgs = {
  damage: number;
  isHealing?: boolean;
  /** Key to group numbers per-fighter for stacking */
  fighterKey: string;
  /** "left" or "right" side of the pairing card */
  side: "left" | "right";
  /** Index of the pairing row (0-based) for vertical positioning */
  pairIndex: number;
};

type Props = {
  /** Width of the parent container for positioning */
  containerWidth: number;
};

export type DamageNumberManagerHandle = {
  spawn: (args: SpawnDamageNumberArgs) => void;
};

export const DamageNumberManager = React.forwardRef<DamageNumberManagerHandle, Props>(
  function DamageNumberManager({ containerWidth }, ref) {
    const [entries, setEntries] = useState<DamageNumberEntry[]>([]);
    const fighterStackCount = useRef<Map<string, number>>(new Map());

    const spawn = useCallback(
      (args: SpawnDamageNumberArgs) => {
        const { damage, isHealing = false, fighterKey, side, pairIndex } = args;
        if (damage <= 0) return;

        const stackCount = fighterStackCount.current.get(fighterKey) ?? 0;
        fighterStackCount.current.set(fighterKey, stackCount + 1);

        // Position: left side ~25% from left, right side ~75% from left
        const baseX = side === "left" ? containerWidth * 0.25 : containerWidth * 0.75;
        const jitter = (Math.random() - 0.5) * JITTER_RANGE;
        const offsetX = baseX + jitter - 30; // -30 to roughly center the text
        // Position vertically relative to the pair row (avatar center area)
        const rowTopY = pairIndex * PAIR_ROW_HEIGHT;
        const offsetY = rowTopY + 30 - stackCount * STACK_OFFSET_Y;

        const id = `dmg_${++nextId}`;
        const entry: DamageNumberEntry = { id, damage, isHealing, offsetX, offsetY };

        setEntries(prev => {
          let next = [...prev, entry];
          // Enforce max per fighter
          const fighterEntries = next.filter(e => e.id.startsWith("dmg_")); // all are damage
          if (fighterEntries.length > MAX_TOTAL) {
            next = next.slice(next.length - MAX_TOTAL);
          }
          return next;
        });

        // Auto-reset stack count after animation lifetime
        setTimeout(() => {
          const current = fighterStackCount.current.get(fighterKey) ?? 0;
          if (current > 0) fighterStackCount.current.set(fighterKey, current - 1);
        }, 1800);
      },
      [containerWidth],
    );

    const handleComplete = useCallback((id: string) => {
      setEntries(prev => prev.filter(e => e.id !== id));
    }, []);

    React.useImperativeHandle(ref, () => ({ spawn }), [spawn]);

    const overlayStyle: ViewStyle = {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      zIndex: 50,
      pointerEvents: "none",
    };

    return (
      <View style={overlayStyle}>
        {entries.map(entry => (
          <DamageNumber key={entry.id} entry={entry} onComplete={handleComplete} />
        ))}
      </View>
    );
  },
);
