"use client";

interface QueueFighter {
  fighterId: string;
  name: string;
  imageUrl?: string | null;
  position: number;
}

interface QueueSidebarProps {
  queue: QueueFighter[];
  totalLength: number;
  nextRumbleIn: string | null;
}

export default function QueueSidebar({
  queue = [],
  totalLength = 0,
  nextRumbleIn,
}: QueueSidebarProps) {
  return (
    <div className="bg-stone-950/60 border border-stone-700 rounded-sm p-4 backdrop-blur-md">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-mono text-sm text-amber-500 uppercase font-bold">
          Fighter Queue
        </h3>
        <span className="font-mono text-xs text-stone-500 bg-stone-800 px-2 py-0.5 rounded-sm">
          {totalLength}
        </span>
      </div>

      {/* Next rumble countdown */}
      {nextRumbleIn && (
        <div className="mb-3 p-2 bg-stone-950/80 border border-stone-800 rounded-sm text-center">
          <span className="font-mono text-[10px] text-stone-500 uppercase">
            Next Rumble In
          </span>
          <p className="font-mono text-sm text-amber-400 font-bold">
            {nextRumbleIn}
          </p>
        </div>
      )}

      {/* Queue list */}
      {queue.length === 0 ? (
        <div className="text-center py-4">
          <p className="font-mono text-xs text-stone-600">
            Queue empty. Fighters needed!
          </p>
        </div>
      ) : (
        <div className="space-y-1 max-h-80 overflow-y-auto">
          {queue.map((f) => (
            <div
              key={f.fighterId}
              className="flex items-center gap-2 py-1.5 px-2 rounded-sm bg-stone-800/30 border border-stone-800/50"
            >
              {/* Position number */}
              <span className="font-mono text-[10px] text-stone-600 w-5 text-right flex-shrink-0">
                {f.position}
              </span>

              {/* Avatar */}
              {f.imageUrl ? (
                <img
                  src={f.imageUrl}
                  alt={f.name}
                  className="w-6 h-6 rounded-sm object-cover border border-stone-700 flex-shrink-0"
                />
              ) : (
                <div className="w-6 h-6 rounded-sm bg-stone-800 flex items-center justify-center border border-stone-700 flex-shrink-0">
                  <span className="text-stone-500 font-mono text-[8px]">B</span>
                </div>
              )}

              {/* Name */}
              <span className="font-mono text-xs text-stone-300 truncate">
                {f.name}
              </span>
            </div>
          ))}
        </div>
      )}

      {totalLength > queue.length && (
        <p className="font-mono text-[10px] text-stone-600 text-center mt-2">
          +{totalLength - queue.length} more in queue
        </p>
      )}
    </div>
  );
}
