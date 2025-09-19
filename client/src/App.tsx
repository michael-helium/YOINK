import React, { useEffect, useMemo, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import { POINTS } from "./lib/scoring";

type ServerState = {
  id: string;
  settings: {
    durationSec: number;
    minLen: number;
    uniqueWords: "disallow"|"allow_no_penalty"|"allow_with_decay";
    decayModel: "linear"|"soft"|"steep";
    revealModel: string;
    roundTiles: number;
    dripPerSec: number;
    surgeAtSec: number;
    surgeAmount: number;
  };
  players: { id: string; name: string; score: number }[];
  pool: Record<string, number>;
  endsInMs: number;
  revealed: number;
  roundTiles: number;
};

type AcceptedEvt = {
  playerId: string;
  name: string;
  letters: number;
  points: number;
  feed: string; // "Alex played 5 letters for 37 points."
};

type EndedEvt = {
  leaderboard: Array<{
    id: string;
    name: string;
    finalScore: number;
    details: Array<{ word: string; base: number; c: number; final: number }>;
  }>;
};

const NUMBER = new Intl.NumberFormat();

export default function App() {
  // Connection
  const [room, setRoom] = useState("test");
  const [name, setName] = useState("Alex");
  const [connected, setConnected] = useState(false);
  const sockRef = useRef<Socket | null>(null);

  // Game state (server-authoritative)
  const [state, setState] = useState<ServerState | null>(null);
  const [feed, setFeed] = useState<string[]>([]);
  const [input, setInput] = useState("");

  // Final leaderboard modal
  const [finals, setFinals] = useState<EndedEvt["leaderboard"] | null>(null);

  // Client-side rate limit (5/sec, burst 10) to match server
  const bucket = useRef({ tokens: 10, last: Date.now() });
  function canClientSubmit(): boolean {
    const now = Date.now();
    const elapsed = (now - bucket.current.last) / 1000;
    bucket.current.last = now;
    bucket.current.tokens = Math.min(10, bucket.current.tokens + elapsed * 5);
    if (bucket.current.tokens >= 1) {
      bucket.current.tokens -= 1;
      return true;
    }
    return false;
  }

  function connect() {
    if (sockRef.current) return;
    const url = import.meta.env.VITE_SOCKET_URL || "http://localhost:5177";
    const s = io(url, { transports: ["websocket"] });
    sockRef.current = s;

    s.on("connect", () => {
      setConnected(true);
      s.emit("lobby:join", { room: room.trim() || "test", name: name.trim() || "Player" });
    });

    s.on("lobby:state", (st: ServerState) => {
      setState(st);
    });

    s.on("word:accepted", (evt: AcceptedEvt) => {
      // Success-only feed line (your wording)
      setFeed(prev => [evt.feed, ...prev].slice(0, 10));
    });

    s.on("round:ended", (evt: EndedEvt) => {
      setFinals(evt.leaderboard);
    });

    s.on("disconnect", () => {
      setConnected(false);
      setState(null);
    });
  }

  function submit() {
    const w = input.trim().toUpperCase();
    if (!connected || !w) return;
    if (!/^[A-Z]+$/.test(w)) return; // success-only, ignore bad
    if (!canClientSubmit()) return;  // success-only, silent
    sockRef.current?.emit("word:submit", { word: w });
    setInput("");
  }

  const sortedPool = useMemo(() => {
    const p = state?.pool || {};
    const entries = Object.entries(p).filter(([, c]) => c > 0);
    entries.sort((a, b) => {
      if (a[0] === "_" && b[0] !== "_") return 1;
      if (b[0] === "_" && a[0] !== "_") return -1;
      return b[1] - a[1] || a[0].localeCompare(b[0]);
    });
    return entries;
  }, [state?.pool]);

  return (
    <div className="min-h-screen flex flex-col">
      {/* Join header */}
      <header className="p-4 border-b border-neutral-800">
        <h1 className="text-2xl font-semibold">YOINK</h1>
        <p className="text-neutral-400 text-sm">Shared-pool speed word game</p>

        {!connected && (
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
            <input
              className="rounded-xl bg-neutral-800 px-3 py-2 outline-none"
              placeholder="Room code"
              value={room}
              onChange={e => setRoom(e.target.value)}
            />
            <input
              className="rounded-xl bg-neutral-800 px-3 py-2 outline-none"
              placeholder="Your name"
              value={name}
              onChange={e => setName(e.target.value)}
            />
            <button
              className="rounded-xl bg-indigo-500 px-3 py-2 font-semibold"
              onClick={connect}
            >
              Join
            </button>
          </div>
        )}
      </header>

      {/* Top bar */}
      <div className="px-4 py-2 flex items-center justify-between">
        <div className="text-lg font-mono">
          {state ? Math.ceil(state.endsInMs / 1000) : "--"}s
        </div>
        <div className="text-sm text-neutral-400">
          Tiles: {state?.revealed ?? 0}/{state?.roundTiles ?? 0}
        </div>
        <div className="text-sm text-neutral-400">
          Players: {state?.players.length ?? 0}
        </div>
      </div>

      {/* Pool */}
      <section className="px-4">
        <div className="grid grid-cols-8 gap-2">
          {sortedPool.map(([ch, count]) => (
            <div key={ch} className="rounded-2xl bg-neutral-900 p-2 flex flex-col items-center">
              <div className="text-2xl font-bold">{ch === "_" ? "␣" : ch}</div>
              <div className="text-xs text-neutral-400">x{count}</div>
              <div className="text-xs mt-1">{POINTS[ch] ?? 0} pts</div>
            </div>
          ))}
        </div>
      </section>

      {/* Input */}
      <section className="px-4 mt-auto pb-3">
        <div className="flex gap-2">
          <input
            className="flex-1 rounded-2xl bg-neutral-900 px-4 py-3 text-lg outline-none"
            placeholder="type a word…"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === "Enter" && submit()}
            disabled={!connected}
          />
          <button
            className="rounded-2xl bg-indigo-500 px-4 py-3 text-lg font-semibold"
            onClick={submit}
            disabled={!connected}
          >
            Play
          </button>
        </div>
        <div className="text-xs text-neutral-500 mt-2">
          Success-only feed • 5 submits/sec rate limit • blanks are ␣ (0 pts)
        </div>
      </section>

      {/* Scoreboard (live) + mini “best word (points)” */}
      <section className="px-4 pb-4">
        <div className="text-sm text-neutral-400 mb-1">Scores (live)</div>
        <ul className="space-y-1">
          {state?.players
            .slice()
            .sort((a, b) => b.score - a.score)
            .map((p) => (
              <li key={p.id} className="flex justify-between">
                <span>{p.name}</span>
                <span className="font-semibold">{NUMBER.format(p.score)}</span>
              </li>
            ))}
        </ul>
      </section>

      {/* Feed (successes only) */}
      <section className="px-4 pb-6">
        <div className="text-sm text-neutral-400 mb-1">Recent</div>
        <ul className="space-y-1">
          {feed.map((f, i) => (
            <li key={i} className="text-sm">{f}</li>
          ))}
        </ul>
      </section>

      {/* Final leaderboard modal */}
      {finals && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-2xl bg-neutral-900 p-4">
            <div className="text-lg font-semibold mb-2">Final scores (after duplicate decay)</div>
            <ul className="space-y-2">
              {finals.map((p, idx) => (
                <li key={p.id} className="flex justify-between">
                  <span>{idx + 1}. {p.name}</span>
                  <span className="font-bold">{NUMBER.format(p.finalScore)}</span>
                </li>
              ))}
            </ul>
            <button
              className="mt-4 w-full rounded-xl bg-neutral-200 text-neutral-900 px-3 py-2 font-semibold"
              onClick={() => setFinals(null)}
            >
              Close
            </button>
            <div className="mt-2 text-xs text-neutral-400">
              Host setting: duplicates with decay (linear by default).
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
