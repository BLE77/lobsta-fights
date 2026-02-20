"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

interface SlotFighter {
  id: string;
  name: string;
  imageUrl?: string | null;
  hp: number;
  maxHp: number;
  isEliminated?: boolean;
}

interface RumbleSlot {
  slotIndex: number;
  rumbleId: string | null;
  rumbleNumber: number | null;
  state: "idle" | "betting" | "combat" | "payout";
  fighters: SlotFighter[];
  currentTurn?: number;
  winnerName?: string;
  winnerImageUrl?: string | null;
}

interface FeedItem {
  id: string;
  tag: string;
  tagColor: string;
  borderColor: string;
  message: string;
  detail?: string;
  imageUrl?: string | null;
}

function buildFeedItems(slots: RumbleSlot[], queueLength: number): FeedItem[] {
  const items: FeedItem[] = [];

  for (const slot of slots) {
    const label = slot.rumbleNumber ? `Rumble #${slot.rumbleNumber}` : `Slot ${slot.slotIndex + 1}`;

    if (slot.state === "betting") {
      items.push({
        id: `${slot.slotIndex}-betting`,
        tag: "BETS OPEN",
        tagColor: "text-green-400",
        borderColor: "border-green-600",
        message: `${label} — betting is live`,
        detail: `${slot.fighters.length} fighters entered`,
        imageUrl: slot.fighters[0]?.imageUrl,
      });
    }

    if (slot.state === "combat") {
      const alive = slot.fighters.filter(f => !f.isEliminated && f.hp > 0);
      const eliminated = slot.fighters.length - alive.length;
      items.push({
        id: `${slot.slotIndex}-combat`,
        tag: "FIGHTING",
        tagColor: "text-red-400",
        borderColor: "border-red-600",
        message: `${label} — Turn ${slot.currentTurn ?? "?"}`,
        detail: eliminated > 0
          ? `${eliminated} eliminated, ${alive.length} remaining`
          : `${alive.length} fighters battling`,
        imageUrl: slot.fighters[0]?.imageUrl,
      });
    }

    if (slot.state === "payout") {
      items.push({
        id: `${slot.slotIndex}-payout`,
        tag: "WINNER",
        tagColor: "text-amber-400",
        borderColor: "border-amber-600",
        message: `${label} — ${slot.winnerName ?? "Unknown"} wins!`,
        detail: "Payouts distributing",
        imageUrl: slot.winnerImageUrl ?? slot.fighters[0]?.imageUrl,
      });
    }

    if (slot.state === "idle") {
      items.push({
        id: `${slot.slotIndex}-idle`,
        tag: "STANDBY",
        tagColor: "text-stone-500",
        borderColor: "border-stone-600",
        message: `${label} — awaiting fighters`,
        detail: queueLength > 0 ? `${queueLength} in queue` : undefined,
      });
    }
  }

  // Sort: active states first (combat > betting > payout > idle)
  const stateOrder: Record<string, number> = { combat: 0, betting: 1, payout: 2, idle: 3 };
  items.sort((a, b) => {
    const aState = a.id.split("-").pop() ?? "idle";
    const bState = b.id.split("-").pop() ?? "idle";
    return (stateOrder[aState] ?? 9) - (stateOrder[bState] ?? 9);
  });

  return items;
}

function FeedItemCard({ item }: { item: FeedItem }) {
  return (
    <Link
      href="/rumble"
      className={`flex items-center gap-3 p-2.5 bg-stone-900/50 hover:bg-stone-800/60 border-l-2 ${item.borderColor} transition-all group`}
    >
      {item.imageUrl ? (
        <img
          src={item.imageUrl}
          alt=""
          className="w-7 h-7 rounded-sm object-cover border border-stone-700 shrink-0"
        />
      ) : (
        <div className="w-7 h-7 rounded-sm bg-stone-800 flex items-center justify-center border border-stone-700 shrink-0">
          <span className="text-stone-600 text-[8px] font-mono">UCF</span>
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={`${item.tagColor} font-mono text-[10px] font-bold shrink-0`}>
            [{item.tag}]
          </span>
          <span className="text-stone-200 font-mono text-xs truncate">{item.message}</span>
        </div>
        {item.detail && (
          <span className="text-stone-500 font-mono text-[10px]">{item.detail}</span>
        )}
      </div>
    </Link>
  );
}

export default function ActivityFeed() {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const res = await fetch(`/api/rumble/status?_t=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();

        const slots: RumbleSlot[] = (data.slots ?? []).map((s: any) => {
          const fighters: SlotFighter[] = (s.fighters ?? []).map((f: any) => ({
            id: f.id,
            name: f.name,
            imageUrl: f.imageUrl ?? null,
            hp: f.hp ?? 0,
            maxHp: f.maxHp ?? 100,
            isEliminated: f.isEliminated ?? false,
          }));

          // Find winner from payout state
          let winnerName: string | undefined;
          let winnerImageUrl: string | null | undefined;
          if (s.state === "payout" && s.payout?.winnerName) {
            winnerName = s.payout.winnerName;
            winnerImageUrl = s.payout.winnerImageUrl;
          } else if (s.state === "payout" && fighters.length > 0) {
            const alive = fighters.filter((f: SlotFighter) => !f.isEliminated && f.hp > 0);
            if (alive.length === 1) {
              winnerName = alive[0].name;
              winnerImageUrl = alive[0].imageUrl;
            }
          }

          return {
            slotIndex: s.slotIndex,
            rumbleId: s.rumbleId,
            rumbleNumber: s.rumbleNumber ?? null,
            state: s.state ?? "idle",
            fighters,
            currentTurn: s.currentTurn,
            winnerName,
            winnerImageUrl,
          };
        });

        const queueLength = data.queueLength ?? 0;
        setItems(buildFeedItems(slots, queueLength));
      } catch {
        // keep last known values
      } finally {
        setLoading(false);
      }
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, 6000);
    return () => clearInterval(interval);
  }, []);

  const activeCount = items.filter(i => !i.id.endsWith("-idle")).length;

  return (
    <div className="bg-stone-900/80 border border-stone-700 rounded-sm backdrop-blur-sm overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-stone-800">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
          </span>
          <h3 className="text-xs font-mono text-stone-400 uppercase tracking-wider">Arena Status</h3>
        </div>
        {activeCount > 0 && (
          <span className="text-[10px] font-mono text-amber-500">{activeCount} active</span>
        )}
      </div>

      <div className="max-h-64 overflow-y-auto divide-y divide-stone-800/50">
        {loading ? (
          <div className="p-4 text-center">
            <span className="text-stone-500 font-mono text-xs animate-pulse">Connecting to arena...</span>
          </div>
        ) : items.length === 0 ? (
          <div className="p-4 text-center">
            <span className="text-stone-500 font-mono text-xs">Arena offline</span>
          </div>
        ) : (
          items.map((item) => <FeedItemCard key={item.id} item={item} />)
        )}
      </div>
    </div>
  );
}
