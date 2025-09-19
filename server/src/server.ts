import express from "express";
import http from "http";
import { Server, Socket } from "socket.io";

// ===== Settings & Types =====
type UniqueWordsMode = "disallow" | "allow_no_penalty" | "allow_with_decay";
type DecayModel = "linear" | "soft" | "steep";

type Settings = {
  durationSec: number;         // default 120
  minLen: number;              // default 3
  uniqueWords: UniqueWordsMode; // default allow_with_decay
  decayModel: DecayModel;       // default linear
  revealModel: "drip_surge";    // (kept simple)
  roundTiles: number;           // default 100
  dripPerSec: number;           // default 2
  surgeAtSec: number;           // default 60
  surgeAmount: number;          // default 10
};

type Player = {
  id: string;
  name: string;
  liveScore: number;  // accumulates during round (pre-decay)
  words: { word: string; base: number }[];
};

type RoomState = {
  id: string;
  settings: Settings;
  players: Map<string, Player>;
  pool: Record<string, number>;    // authoritative shared tile counts
  started: boolean;
  endAt?: number;
  // reveal engine
  bag: string[];
  revealed: number;
  // shadow queue
  shadowWindowMs: number;
  pending: Map<number, Submission[]>;
  // word usage for decay
  wordCounts: Map<string, number>;
  // housekeeping
  tick?: NodeJS.Timeout;
};

type Submission = {
  ts: number;
  socketId: string;
  playerId: string;
  word: string; // UPPERCASE
};

const POINTS: Record<string, number> = {
  "_": 0,
  E: 1, A: 1, O: 1, T: 1, I: 1, N: 1, R: 1, S: 1, L: 1, U: 1,
  D: 2, G: 2,
  C: 3, M: 3, B: 3, P: 3,
  H: 4, F: 4, W: 4, Y: 4, V: 4,
  K: 5,
  J: 8, X: 8,
  Q: 10, Z: 10
};

const COUNTS: Record<string, number> = {
  "_": 4,
  E: 24, A: 16, O: 15, T: 15, I: 13, N: 13, R: 13, S: 10, L: 7, U: 7,
  D: 8, G: 5,
  C: 6, M: 6, B: 4, P: 4,
  H: 5, F: 4, W: 4, Y: 4, V: 3,
  K: 2, J: 2, X: 2, Q: 2, Z: 2
};

// Small demo dictionary (replace with a real set later)
const DICT = new Set<string>([
  "TEAM", "TEAMS", "MEAT", "TAME", "TONE", "STONE", "NOTES", "ONES",
  "RUSH", "QUARTZ", "BOX", "FOX", "QUAD", "JAZZ", "FUZZ", "VEX",
  "CART", "CARTS", "SCAR", "SCARF", "FRAME", "LATER", "RATES",
  "NEARS", "LEARN", "MEANS", "MEANT", "MEAL", "STEAM", "STREAM",
  "WON", "WANE", "WAX", "WAXES", "WAXED"
]);

// ===== Server boot =====
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Health
app.get("/", (_req, res) => res.send("YOINK word server running"));

// Rooms
const rooms = new Map<string, RoomState>();

// ===== Utility fns =====
function scoreWord(word: string): number {
  const base = [...word].reduce((s, ch) => s + (POINTS[ch] ?? 0), 0);
  const bonus = 1 + 0.05 * word.length;
  return Math.round(base * bonus);
}
function makeBag(): string[] {
  const bag: string[] = [];
  Object.entries(COUNTS).forEach(([ch, n]) => {
    for (let i = 0; i < n; i++) bag.push(ch);
  });
  // shuffle Fisher-Yates
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  return bag;
}
function seedPool(): Record<string, number> {
  return { ...COUNTS };
}
function canConsumeWord(word: string, pool: Record<string, number>): boolean {
  const need: Record<string, number> = {};
  for (const ch of word) need[ch] = (need[ch] ?? 0) + 1;
  const have = { ...pool };
  // spend exact letters first
  for (const ch of Object.keys(need)) {
    const take = Math.min(need[ch], have[ch] ?? 0);
    need[ch] -= take;
    have[ch] = (have[ch] ?? 0) - take;
  }
  // blanks cover remainder
  const remain = Object.values(need).reduce((s, c) => s + c, 0);
  return (have["_"] ?? 0) >= remain;
}
function consumeWord(word: string, pool: Record<string, number>) {
  for (const ch of word) {
    if ((pool[ch] ?? 0) > 0) pool[ch]!--;
    else if ((pool["_"] ?? 0) > 0) pool["_"]!--;
  }
}
function nowWindowKey(nowMs: number, sizeMs: number): number {
  return Math.floor(nowMs / sizeMs);
}
function publicState(r: RoomState) {
  return {
    id: r.id,
    settings: r.settings,
    players: [...r.players.values()].map(p => ({ id: p.id, name: p.name, score: p.liveScore })),
    pool: r.pool,
    endsInMs: Math.max(0, (r.endAt ?? Date.now()) - Date.now()),
    revealed: r.revealed,
    roundTiles: r.settings.roundTiles
  };
}

// Rate limiter: 5/sec, burst 10
const buckets = new Map<string, { tokens: number; last: number }>();
function allowSubmit(socketId: string): boolean {
  const cap = 10, rate = 5;
  const now = Date.now();
  const t = buckets.get(socketId) ?? { tokens: cap, last: now };
  const elapsed = (now - t.last) / 1000;
  t.tokens = Math.min(cap, t.tokens + elapsed * rate);
  t.last = now;
  if (t.tokens >= 1) {
    t.tokens -= 1;
    buckets.set(socketId, t);
    return true;
  }
  buckets.set(socketId, t);
  return false;
}

// ===== Room lifecycle =====
function ensureRoom(roomId: string): RoomState {
  let r = rooms.get(roomId);
  if (r) return r;

  const settings: Settings = {
    durationSec: 120,
    minLen: 3,
    uniqueWords: "allow_with_decay",
    decayModel: "linear",
    revealModel: "drip_surge",
    roundTiles: 100,
    dripPerSec: 2,
    surgeAtSec: 60,
    surgeAmount: 10
  };
  r = {
    id: roomId,
    settings,
    players: new Map(),
    pool: {},
    started: false,
    bag: [],
    revealed: 0,
    shadowWindowMs: 150,
    pending: new Map(),
    wordCounts: new Map()
  };
  rooms.set(roomId, r);
  return r;
}

function startRound(r: RoomState) {
  r.pool = {};
  r.bag = makeBag();
  r.revealed = 0;
  r.wordCounts.clear();
  r.pending.clear();
  for (const p of r.players.values()) {
    p.liveScore = 0;
    p.words = [];
  }
  r.started = true;
  r.endAt = Date.now() + r.settings.durationSec * 1000;

  // opening flood (20 tiles)
  const open = Math.min(20, r.settings.roundTiles);
  const openTiles = r.bag.slice(0, open);
  for (const ch of openTiles) r.pool[ch] = (r.pool[ch] ?? 0) + 1;
  r.revealed = open;

  // tick: drip + optional surge + end
  r.tick && clearInterval(r.tick);
  r.tick = setInterval(() => {
    const now = Date.now();
    if (now >= (r.endAt ?? now)) {
      clearInterval(r.tick!);
      r.tick = undefined;
      r.started = false;
      finalizeRoundWithDecay(r);
      return;
    }

    // drip
    if (r.revealed < r.settings.roundTiles) {
      const take = Math.min(r.settings.dripPerSec, r.settings.roundTiles - r.revealed);
      const more = r.bag.slice(r.revealed, r.revealed + take);
      for (const ch of more) r.pool[ch] = (r.pool[ch] ?? 0) + 1;
      r.revealed += take;
    }

    // surge once when crossing surgeAtSec (relative)
    const elapsed = Math.round(((r.settings.durationSec * 1000) - ((r.endAt ?? now) - now)) / 1000);
    if (elapsed >= r.settings.surgeAtSec && r.settings.surgeAmount > 0) {
      // consume surge and set to 0 so it doesn't repeat
      const take = Math.min(r.settings.surgeAmount, r.settings.roundTiles - r.revealed);
      if (take > 0) {
        const more = r.bag.slice(r.revealed, r.revealed + take);
        for (const ch of more) r.pool[ch] = (r.pool[ch] ?? 0) + 1;
        r.revealed += take;
      }
      r.settings.surgeAmount = 0; // one-time
    }

    // emit state
    io.to(r.id).emit("lobby:state", publicState(r));

    // process the shadow window that just closed
    const key = nowWindowKey(now - r.shadowWindowMs, r.shadowWindowMs);
    processShadowWindow(r, key);
  }, 1000);
}

function processShadowWindow(r: RoomState, windowKey: number) {
  const subs = r.pending.get(windowKey);
  if (!subs || subs.length === 0) return;

  // Snapshot pool
  const snapshot: Record<string, number> = { ...r.pool };
  subs.sort((a, b) => a.ts - b.ts);

  const accepted: Submission[] = [];
  for (const s of subs) {
    const word = s.word;
    // validity first
    if (!/^[A-Z]+$/.test(word)) continue;
    if (word.length < r.settings.minLen) continue;
    if (!DICT.has(word)) continue;

    // uniqueWords "disallow" prevents same player repeating it
    if (r.settings.uniqueWords === "disallow") {
      const p = r.players.get(s.playerId);
      if (p && p.words.find(w => w.word === word)) continue;
    }

    // against snapshot
    if (canConsumeWord(word, snapshot)) {
      consumeWord(word, snapshot);
      accepted.push(s);
    }
  }

  // Apply to authoritative state + emit successes
  for (const s of accepted) {
    const p = r.players.get(s.playerId);
    if (!p) continue;
    const pts = scoreWord(s.word);

    // final authoritative consume
    consumeWord(s.word, r.pool);

    // track for live score + later decay
    p.words.push({ word: s.word, base: pts });
    p.liveScore += pts;
    r.wordCounts.set(s.word, (r.wordCounts.get(s.word) ?? 0) + 1);

    io.to(r.id).emit("word:accepted", {
      playerId: s.playerId,
      name: p.name,
      letters: s.word.length,
      points: pts,
      feed: `${p.name} played ${s.word.length} letters for ${pts} points.`
    });
  }

  r.pending.delete(windowKey);
}

function finalizeRoundWithDecay(r: RoomState) {
  const model = r.settings.decayModel;

  function decay(base: number, c: number): number {
    if (r.settings.uniqueWords === "allow_no_penalty") return base;
    if (r.settings.uniqueWords === "disallow") return base; // duplicates didn't count
    if (c <= 1) return base;
    let factor = 1;
    if (model === "linear") factor = 1 / c;
    else if (model === "soft") factor = 1 / (1 + 0.6 * (c - 1));
    else if (model === "steep") factor = 1 / Math.pow(c, 1.3);
    return Math.round(base * factor);
  }

  // compute final scores
  const final = [...r.players.values()].map(p => {
    let finalScore = 0;
    const details = p.words.map(w => {
      const c = r.wordCounts.get(w.word) ?? 1;
      const adj = decay(w.base, c);
      finalScore += adj;
      return { word: w.word, base: w.base, c, final: adj };
    });
    return { id: p.id, name: p.name, finalScore, details };
  }).sort((a, b) => b.finalScore - a.finalScore);

  io.to(r.id).emit("round:ended", { leaderboard: final });

  // broadcast idle lobby state
  io.to(r.id).emit("lobby:state", publicState(r));
}

// ===== Socket wiring =====
io.on("connection", (socket: Socket) => {
  let roomId: string | null = null;
  let playerId: string | null = null;

  socket.on("lobby:join", ({ room, name }: { room: string; name: string }) => {
    roomId = room;
    playerId = socket.id;

    const r = ensureRoom(room);
    r.players.set(socket.id, { id: socket.id, name: name?.slice(0, 16) || "Player", liveScore: 0, words: [] });
    socket.join(room);

    // auto-start a round if not started
    if (!r.started) startRound(r);

    io.to(room).emit("lobby:state", publicState(r));
  });

  socket.on("word:submit", (payload: { word: string }) => {
    if (!roomId || !playerId) return;
    const r = rooms.get(roomId);
    if (!r || !r.started) return;
    if (!allowSubmit(socket.id)) return; // silent per "success-only feed"

    const word = (payload.word || "").toUpperCase();
    const ts = Date.now();
    const key = nowWindowKey(ts, r.shadowWindowMs);
    if (!r.pending.has(key)) r.pending.set(key, []);
    r.pending.get(key)!.push({ ts, socketId: socket.id, playerId, word });
  });

  socket.on("disconnect", () => {
    if (!roomId || !playerId) return;
    const r = rooms.get(roomId);
    if (!r) return;
    r.players.delete(playerId);
    io.to(roomId).emit("lobby:state", publicState(r));
  });
});

const PORT = process.env.PORT || 5177;
server.listen(PORT, () => {
  console.log(`YOINK server listening on :${PORT}`);
});
