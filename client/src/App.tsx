import React, { useEffect, useMemo, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import { POINTS, scoreWord } from "./lib/scoring";

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

// --- constants for offline sim ---
const COUNTS: Record<string, number> = {
  "_":4,
  E:24,A:16,O:15,T:15,I:13,N:13,R:13,S:10,L:7,U:7,
  D:8,G:5,C:6,M:6,B:4,P:4,H:5,F:4,W:4,Y:4,V:3,
  K:2,J:2,X:2,Q:2,Z:2
};
function makeBag(): string[] {
  const bag: string[] = [];
  for (const [ch, n] of Object.entries(COUNTS)) for (let i=0;i<n;i++) bag.push(ch);
  for (let i=bag.length-1;i>0;i--) { const j=Math.floor(Math.random()*(i+1)); [bag[i],bag[j]]=[bag[j],bag[i]]; }
  return bag;
}
function poolFromTiles(tiles: string[]): Record<string,number> {
  const p: Record<string,number> = {};
  for (const ch of tiles) p[ch]=(p[ch]??0)+1;
  return p;
}
function canConsume(word: string, pool: Record<string,number>): boolean {
  const need: Record<string,number> = {};
  for (const ch of word) need[ch]=(need[ch]??0)+1;
  const have = { ...pool };
  for (const ch of Object.keys(need)) {
    const take = Math.min(need[ch], have[ch] ?? 0);
    need[ch]-=take; have[ch]=(have[ch]??0)-take;
  }
  const remain = Object.values(need).reduce((s,c)=>s+c,0);
  return (have["_"] ?? 0) >= remain;
}
function consume(word: string, pool: Record<string,number>): Record<string,number> {
  const next = { ...pool };
  for (const ch of word) {
    if ((next[ch]??0)>0) next[ch]!--;
    else if ((next["_"]??0)>0) next["_"]!--;
  }
  return next;
}

export default function App() {
  // connection + UI
  const [room, setRoom] = useState("test");
  const [name, setName] = useState("Michael");
  const [connected, setConnected] = useState(false);
  const [feed, setFeed] = useState<string[]>([]);
  const [input, setInput] = useState("");

  // server state
  const [state, setState] = useState<ServerState | null>(null);
  const [finals, setFinals] = useState<EndedEvt["leaderboard"] | null>(null);
  const sockRef = useRef<Socket | null>(null);

  // offline sim state
  const [offlineSim, setOfflineSim] = useState(false);
  const [timeLeft, setTimeLeft] = useState(120);
  const [pool, setPool] = useState<Record<string,number>>({});
  const [revealed, setRevealed] = useState(0);
  const [roundTiles] = useState(100);
  const [dripPerSec] = useState(2);
  const [surgeAt] = useState(60);
  const [surgeUsed, setSurgeUsed] = useState(false);
  const [myScore, setMyScore] = useState(0);
  const [myWords, setMyWords] = useState<string[]>([]);
  const bagRef = useRef<string[]>([]);
  const timerRef = useRef<number | null>(null);

  // client-side rate limit to match server
  const bucket = useRef({ tokens: 10, last: Date.now() });
  function canClientSubmit(): boolean {
    const now = Date.now(); const elapsed = (now - bucket.current.last)/1000;
    bucket.current.last = now;
    bucket.current.tokens = Math.min(10, bucket.current.tokens + elapsed * 5);
    if (bucket.current.tokens >= 1) { bucket.current.tokens -= 1; return true; }
    return false;
  }

  function connect() {
    // Try to connect to server; if we can't within 1500ms, fall back
    const url = import.meta.env.VITE_SOCKET_URL || "";
    if (!url) {
      setOfflineSim(true);
      return;
    }
    const s = io(url, { transports: ["websocket"], timeout: 1000 });
    sockRef.current = s;

    let fallbackTimer = window.setTimeout(() => {
      if (!s.connected) {
        setOfflineSim(true);
      }
    }, 1500);

    s.on("connect", () => {
      clearTimeout(fallbackTimer);
      setConnected(true);
      s.emit("lobby:join", { room: room.trim() || "test", name: name.trim() || "Player" });
    });

    s.on("lobby:state", (st: ServerState) => setState(st));
    s.on("word:accepted", (evt: AcceptedEvt) => {
      setFeed(prev => [evt.feed, ...prev].slice(0, 10));
    });
    s.on("round:ended", (evt: EndedEvt) => setFinals(evt.leaderboard));

    s.on("disconnect", () => {
      setConnected(false);
      setState(null);
    });
  }

  function startOfflineRound() {
    // reset
    setFeed([]); setMyScore(0); setMyWords([]);
    setPool({}); setRevealed(0); setSurgeUsed(false);
    setTimeLeft(120);
    bagRef.current = makeBag();

    // opening flood
    const open = Math.min(20, roundTiles);
    const initial = bagRef.current.slice(0, open);
    setPool(poolFromTiles(initial));
    setRevealed(open);

    // tick
    timerRef.current && clearInterval(timerRef.current);
    timerRef.current = window.setInterval(() => {
      setTimeLeft(t => {
        if (t <= 1) {
          clearInterval(timerRef.current!);
          setFinals([{ id: "me", name, finalScore: myScore, details: myWords.map(w=>({word:w,base:scoreWord(w),c:1,final:scoreWord(w)})) }]);
          return 0;
        }
        return t - 1;
      });

      // drip
      setPool(prev => {
        setRevealed(r => {
          if (r >= roundTiles) return r;
          const take = Math.min(dripPerSec, roundTiles - r);
          const more = bagRef.current.slice(r, r + take);
          const next = { ...prev };
          for (const ch of more) next[ch] = (next[ch] ?? 0) + 1;
          return r + take;
        });
        return prev;
      });

      // surge once
      setTimeout(() => {
        setSurgeUsed(done => {
          if (done) return true;
          const elapsed = 120 - (timeLeft - 1);
          if (elapsed >= surgeAt) {
            setPool(prev => {
              setRevealed(r => {
                const take = Math.min(10, roundTiles - r);
                const more = bagRef.current.slice(r, r + take);
                const next = { ...prev };
                for (const ch of more) next[ch] = (next[ch] ?? 0) + 1;
                return r + take;
              });
              return prev;
            });
            return true;
          }
          return false;
        });
      }, 0);
    }, 1000) as unknown as number;
  }

  function submit() {
    const w = input.trim().toUpperCase();
    if (!w) return;
    if (!/^[A-Z]+$/.test(w)) return; // success-only

    if (!canClientSubmit()) return;

    if (offlineSim) {
      // local path
      if (w.length < 3) return;
      if (!canConsume(w, pool)) return;
      const pts = scoreWord(w);
      setMyScore(s => s + pts);
      setMyWords(ws => [...ws, w]);
      setPool(p => consume(w, p));
      setFeed(prev => [`${name} played ${w.length} letters for ${pts} points.`, ...prev].slice(0,10));
      setInput("");
      return;
    }

    if (!connected) return;
    sockRef.current?.emit("word:submit", { word: w });
    setInput("");
  }

  // UI helpers
// Build a flat array of individual tiles from the pool, then shuffle it.
// This removes grouping by letter and makes the board look random.
const tiles = useMemo(() => {
  const src = offlineSim ? pool : (state?.pool || {});
  const arr: string[] = [];
  for (const [ch, count] of Object.entries(src)) {
    for (let i = 0; i < (count ?? 0); i++) arr.push(ch);
  }
  // Fisher–Yates shuffle
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}, [offlineSim, pool, state?.pool]);


  const tilesText = offlineSim
    ? `${revealed}/${roundTiles}`
    : `${state?.revealed ?? 0}/${state?.roundTiles ?? 0}`;

  const seconds = offlineSim ? timeLeft : Math.ceil((state?.endsInMs ?? 0)/1000);
  const playersCount = offlineSim ? 1 : (state?.players.length ?? 0);

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header / Join */}
      <header className="p-4 border-b border-neutral-800">
        <h1 className="text-2xl font-semibold">YOINK</h1>
        <p className="text-neutral-400 text-sm">Shared-pool speed word game</p>

        {!connected && !offlineSim && (
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
            <button className="rounded-xl bg-indigo-500 px-3 py-2 font-semibold" onClick={connect}>
              Join
            </button>
          </div>
        )}

        {offlineSim && (
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
            <input
              className="rounded-xl bg-neutral-800 px-3 py-2 outline-none"
              placeholder="Your name"
              value={name}
              onChange={e => setName(e.target.value)}
            />
            <button
              className="rounded-xl bg-amber-500 px-3 py-2 font-semibold"
              onClick={startOfflineRound}
            >
              Play offline demo
            </button>
            <small className="text-xs text-amber-300 sm:col-span-1">
              Server not reachable — offline demo mode.
            </small>
          </div>
        )}
      </header>

      {/* Top bar */}
      <div className="px-4 py-2 flex items-center justify-between">
        <div className="text-lg font-mono">{Number.isFinite(seconds) ? seconds : "--"}s</div>
        <div className="text-sm text-neutral-400">Tiles: {tilesText}</div>
        <div className="text-sm text-neutral-400">Players: {playersCount}</div>
      </div>

      {/* Pool */}
<section className="px-4">
  <div className="grid grid-cols-8 gap-2">
    {sortedPool.flatMap(([ch, count]) =>
      Array.from({ length: count }, (_, i) => (
        <div
          key={`${ch}-${i}`}
          className="relative aspect-square rounded-xl bg-neutral-900 flex items-center justify-center text-2xl font-bold"
        >
          {ch === "_" ? "␣" : ch}
          <span className="absolute bottom-1 right-1 text-[0.6rem] font-semibold text-neutral-400">
            {POINTS[ch] ?? 0}
          </span>
        </div>
      ))
    )}
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
            disabled={(!connected && !offlineSim) || seconds <= 0}
          />
          <button
            className="rounded-2xl bg-indigo-500 px-4 py-3 text-lg font-semibold"
            onClick={submit}
            disabled={(!connected && !offlineSim) || seconds <= 0}
          >
            Play
          </button>
        </div>
        <div className="text-xs text-neutral-500 mt-2">
          Success-only feed • 5 submits/sec rate limit • blanks are ␣ (0 pts)
        </div>
      </section>

      {/* Scores */}
      <section className="px-4 pb-4">
        <div className="text-sm text-neutral-400 mb-1">Scores (live)</div>
        <ul className="space-y-1">
          {offlineSim ? (
            <li className="flex justify-between">
              <span>{name}</span>
              <span className="font-semibold">{NUMBER.format(myScore)}</span>
            </li>
          ) : (
            state?.players
              .slice()
              .sort((a, b) => b.score - a.score)
              .map((p) => (
                <li key={p.id} className="flex justify-between">
                  <span>{p.name}</span>
                  <span className="font-semibold">{NUMBER.format(p.score)}</span>
                </li>
              ))
          )}
        </ul>
      </section>

      {/* Feed */}
      <section className="px-4 pb-6">
        <div className="text-sm text-neutral-400 mb-1">Recent</div>
        <ul className="space-y-1">
          {feed.map((f, i) => <li key={i} className="text-sm">{f}</li>)}
        </ul>
      </section>

      {/* Final leaderboard modal */}
      {finals && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-2xl bg-neutral-900 p-4">
            <div className="text-lg font-semibold mb-2">Final scores</div>
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
              {offlineSim ? "Offline demo uses your local bag only." : "Includes duplicate decay if enabled."}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
