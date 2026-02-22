"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { getSupabaseBrowserClient } from "~~/lib/supabase-client";

interface ChatMessage {
  id: string;
  user_id: string;
  username: string;
  message: string;
  created_at: string;
}

interface ChatPanelProps {
  walletAddress: string | null;
}

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 10) return "now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

export default function ChatPanel({ walletAddress }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const shouldAutoScroll = useRef(true);

  // Track if user is near the bottom to auto-scroll
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    shouldAutoScroll.current = distFromBottom < 60;
  }, []);

  const scrollToBottom = useCallback(() => {
    if (shouldAutoScroll.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  // Load initial messages
  useEffect(() => {
    const loadMessages = async () => {
      try {
        const res = await fetch("/api/chat");
        if (res.ok) {
          const data = await res.json();
          setMessages(data);
          // Force scroll on initial load
          shouldAutoScroll.current = true;
          setTimeout(scrollToBottom, 50);
        }
      } catch {
        // silent fail on initial load
      }
    };
    loadMessages();
  }, [scrollToBottom]);

  // Subscribe to realtime inserts
  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    const channel = supabase
      .channel("chat_messages_realtime")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "chat_messages" },
        (payload) => {
          const newMsg = payload.new as ChatMessage;
          setMessages((prev) => {
            // Deduplicate by id
            if (prev.some((m) => m.id === newMsg.id)) return prev;
            // Keep last 50
            const updated = [...prev, newMsg];
            if (updated.length > 50) updated.shift();
            return updated;
          });
          setTimeout(scrollToBottom, 50);
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [scrollToBottom]);

  // Scroll on new messages
  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const sendMessage = async () => {
    if (!walletAddress || !input.trim() || sending) return;

    const trimmed = input.trim();
    if (trimmed.length > 500) {
      setError("Max 500 characters");
      return;
    }

    setSending(true);
    setError(null);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallet_address: walletAddress,
          message: trimmed,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to send");
        return;
      }

      setInput("");
    } catch {
      setError("Failed to send message");
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="bg-stone-950/60 border border-stone-700 rounded-sm backdrop-blur-md flex flex-col h-[400px] xl:h-[calc(100vh-140px)]">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-stone-800">
        <h3 className="font-mono text-sm text-amber-500 uppercase font-bold">
          Live Chat
        </h3>
        <span className="font-mono text-[10px] text-stone-600">
          {messages.length} msgs
        </span>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-4 py-2 space-y-1.5 scrollbar-thin scrollbar-thumb-stone-700 scrollbar-track-transparent"
        style={{ maskImage: "linear-gradient(to bottom, transparent, black 15%)", WebkitMaskImage: "linear-gradient(to bottom, transparent, black 15%)" }}
      >
        {messages.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <p className="font-mono text-[10px] text-stone-600">
              No messages yet. Say something!
            </p>
          </div>
        ) : (
          messages.map((msg) => {
            const isMe = walletAddress && msg.user_id === walletAddress;
            return (
              <div key={msg.id} className="group">
                <div className="flex items-baseline gap-1.5">
                  <span
                    className={`font-mono text-[11px] font-bold flex-shrink-0 ${isMe ? "text-amber-400" : "text-stone-400"
                      }`}
                  >
                    {msg.username}
                  </span>
                  <span className="font-mono text-[10px] text-stone-600 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    {timeAgo(msg.created_at)}
                  </span>
                </div>
                <p className="font-mono text-xs text-stone-300 break-words leading-relaxed pl-0">
                  {msg.message}
                </p>
              </div>
            );
          })
        )}
      </div>

      {/* Input */}
      <div className="border-t border-stone-800 px-4 py-2">
        {error && (
          <p className="font-mono text-[10px] text-red-400 mb-1">{error}</p>
        )}
        {walletAddress ? (
          <div className="flex gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a message..."
              maxLength={500}
              disabled={sending}
              className="flex-1 bg-stone-950/80 border border-stone-700 rounded-sm px-2 py-1.5 font-mono text-xs text-stone-200 placeholder-stone-600 focus:outline-none focus:border-amber-600/50 disabled:opacity-50"
            />
            <button
              onClick={sendMessage}
              disabled={sending || !input.trim()}
              className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 disabled:bg-stone-700 disabled:text-stone-500 text-stone-950 font-mono text-[10px] font-bold uppercase rounded-sm transition-all flex-shrink-0"
            >
              {sending ? "..." : "Send"}
            </button>
          </div>
        ) : (
          <div className="text-center py-1">
            <p className="font-mono text-[10px] text-stone-500">
              Connect wallet to chat
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
