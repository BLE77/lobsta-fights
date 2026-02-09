"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

interface ActivityEvent {
  id: string;
  type: "match_finished" | "fighter_registered" | "fighter_joined_lobby";
  timestamp: string;
  data: Record<string, any>;
}

function relativeTime(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diff = Math.floor((now - then) / 1000);

  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function FighterAvatar({ src, name, size = "w-6 h-6" }: { src?: string | null; name: string; size?: string }) {
  if (src) {
    return <img src={src} alt={name} className={`${size} rounded-sm object-cover border border-stone-700`} />;
  }
  return (
    <div className={`${size} rounded-sm bg-stone-800 flex items-center justify-center border border-stone-700`}>
      <span className="text-stone-600 text-[8px] font-mono">BOT</span>
    </div>
  );
}

function EventCard({ event }: { event: ActivityEvent }) {
  const { type, data, timestamp } = event;

  if (type === "match_finished") {
    return (
      <Link
        href={`/matches/${data.match_id}`}
        className="flex items-center gap-3 p-2.5 bg-stone-900/50 hover:bg-stone-800/60 border-l-2 border-amber-600 transition-all group"
      >
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <span className="text-amber-500 font-mono text-[10px] font-bold shrink-0">[KO]</span>
          <FighterAvatar src={data.winner_image} name={data.winner_name} />
          <span className="text-green-400 font-mono text-xs font-bold truncate">{data.winner_name}</span>
          <span className="text-stone-600 text-xs shrink-0">def.</span>
          <FighterAvatar src={data.loser_image} name={data.loser_name} />
          <span className="text-red-400 font-mono text-xs truncate">{data.loser_name}</span>
          <span className="text-amber-600 text-[10px] font-mono shrink-0">+{data.points_wager}</span>
        </div>
        <span className="text-stone-600 text-[10px] font-mono shrink-0">{relativeTime(timestamp)}</span>
      </Link>
    );
  }

  if (type === "fighter_registered") {
    return (
      <Link
        href={`/fighter/${data.fighter_id}`}
        className="flex items-center gap-3 p-2.5 bg-stone-900/50 hover:bg-stone-800/60 border-l-2 border-red-600 transition-all group"
      >
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <span className="text-red-500 font-mono text-[10px] font-bold shrink-0">[NEW]</span>
          <FighterAvatar src={data.fighter_image} name={data.fighter_name} />
          <span className="text-stone-200 font-mono text-xs font-bold truncate">{data.fighter_name}</span>
          <span className="text-stone-600 text-xs">entered the arena</span>
        </div>
        <span className="text-stone-600 text-[10px] font-mono shrink-0">{relativeTime(timestamp)}</span>
      </Link>
    );
  }

  if (type === "fighter_joined_lobby") {
    return (
      <Link
        href={`/fighter/${data.fighter_id}`}
        className="flex items-center gap-3 p-2.5 bg-stone-900/50 hover:bg-stone-800/60 border-l-2 border-yellow-600 transition-all group"
      >
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <span className="text-yellow-500 font-mono text-[10px] font-bold shrink-0">[QUEUE]</span>
          <FighterAvatar src={data.fighter_image} name={data.fighter_name} />
          <span className="text-stone-200 font-mono text-xs font-bold truncate">{data.fighter_name}</span>
          <span className="text-stone-600 text-xs">looking for a fight</span>
        </div>
        <span className="text-stone-600 text-[10px] font-mono shrink-0">{relativeTime(timestamp)}</span>
      </Link>
    );
  }

  return null;
}

export default function ActivityFeed() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchActivity = async () => {
      try {
        const res = await fetch("/api/activity");
        const data = await res.json();
        setEvents(data.events || []);
      } catch (e) {
        console.error("Failed to fetch activity:", e);
      } finally {
        setLoading(false);
      }
    };

    fetchActivity();
    const interval = setInterval(fetchActivity, 8000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="bg-stone-900/80 border border-stone-700 rounded-sm backdrop-blur-sm overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-stone-800">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
          </span>
          <h3 className="text-xs font-mono text-stone-400 uppercase tracking-wider">Live Activity</h3>
        </div>
        <span className="text-[10px] font-mono text-stone-600">{events.length} events</span>
      </div>

      <div className="max-h-64 overflow-y-auto divide-y divide-stone-800/50">
        {loading ? (
          <div className="p-4 text-center">
            <span className="text-stone-600 font-mono text-xs animate-pulse">Loading feed...</span>
          </div>
        ) : events.length === 0 ? (
          <div className="p-4 text-center">
            <span className="text-stone-600 font-mono text-xs">No recent activity</span>
          </div>
        ) : (
          events.map((event) => <EventCard key={event.id} event={event} />)
        )}
      </div>
    </div>
  );
}
