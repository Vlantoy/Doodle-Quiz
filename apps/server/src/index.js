import express from "express";
import cors from "cors";
import { randomUUID, randomBytes } from "node:crypto";
import { config } from "./config.js";
import {
  cleanupRoomSchema,
  hostRoomSchema,
  joinRoomSchema,
  startRoundSchema,
  submitRoundSchema
} from "./schemas.js";
import { generateGameCode, normalizeCode, randomAvatarSeed } from "./utils.js";
import {
  hitTestQuestion,
  stripAnswersFromQuestion,
  stripAnswersFromQuiz,
  computeRngFactor,
  signPlayerToken,
  verifyPlayerToken
} from "./game.js";

const rooms = new Map();
const players = new Map();
const leaderboard = [];

const SERVER_SECRET = process.env.SERVER_SECRET || randomBytes(32).toString("hex");
const ROOM_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const SWEEP_INTERVAL_MS = 10 * 60 * 1000; // 10min
const MAX_ROOMS = 500;

function getRoom(code) { return rooms.get(code) ?? null; }
function getPlayers(code) { return players.get(code) ?? []; }

function sweepExpired() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.created_at > ROOM_TTL_MS) {
      rooms.delete(code);
      players.delete(code);
    }
  }
}
const sweepTimer = setInterval(sweepExpired, SWEEP_INTERVAL_MS);
if (sweepTimer.unref) sweepTimer.unref();

const app = express();
const allowedOrigins = [config.corsOrigin, "http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"];
const localNetworkRegex = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+)(:\d+)?$/;
app.use(cors({ origin: (origin, cb) => {
  const isLocal = !origin || localNetworkRegex.test(origin);
  cb(null, isLocal || allowedOrigins.includes(origin));
} }));
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => { res.json({ ok: true, service: "cute-quiz-referee" }); });

app.post("/api/rooms/host", (req, res) => {
  console.log("Incoming host request:", JSON.stringify(req.body).slice(0, 1000) + "...");
  const parsed = hostRoomSchema.safeParse(req.body);
  if (!parsed.success) {
    console.error("Zod validation failed for host:", JSON.stringify(parsed.error.format(), null, 2));
    return res.status(400).json({ error: "INVALID_PAYLOAD", details: parsed.error.flatten() });
  }
  if (rooms.size >= MAX_ROOMS) {
    sweepExpired();
    if (rooms.size >= MAX_ROOMS) return res.status(503).json({ error: "SERVER_AT_CAPACITY" });
  }
  const payload = parsed.data;
  let code;
  for (let i = 0; i < 5; i++) { const c = generateGameCode(); if (!rooms.has(c)) { code = c; break; } }
  if (!code) return res.status(500).json({ error: "ROOM_CODE_COLLISION_LIMIT" });
  const now = Date.now();
  const hostSecret = randomBytes(24).toString("hex");
  rooms.set(code, {
    code,
    host_player_id: payload.hostPlayerId,
    host_username: payload.hostUsername,
    host_secret: hostSecret,
    round_duration_sec: payload.roundDurationSec,
    quiz_payload: payload.quiz,
    current_round_index: 0,
    round_started_at: null,
    round_deadline_at: null,
    submit_mask: 0,
    win_mask: 0,
    is_active: true,
    created_at: now
  });
  players.set(code, []);
  const playerToken = signPlayerToken(SERVER_SECRET, code, payload.hostPlayerId);
  return res.json({
    roomCode: code,
    hostPlayerId: payload.hostPlayerId,
    hostSecret,
    playerToken,
    roundDurationSec: payload.roundDurationSec
  });
});

app.post("/api/rooms/join", (req, res) => {
  const parsed = joinRoomSchema.safeParse({ ...req.body, roomCode: normalizeCode(req.body?.roomCode) });
  if (!parsed.success) return res.status(400).json({ error: "INVALID_PAYLOAD", details: parsed.error.flatten() });
  const payload = parsed.data;
  const room = getRoom(payload.roomCode);
  if (!room || !room.is_active) return res.status(404).json({ error: "ROOM_NOT_FOUND" });
  const list = getPlayers(payload.roomCode);
  const existing = list.find(p => p.player_id === payload.playerId);
  if (existing) {
    const playerToken = signPlayerToken(SERVER_SECRET, payload.roomCode, payload.playerId);
    return res.json({ roomCode: payload.roomCode, playerId: payload.playerId, seatIndex: existing.seat_index, avatarSeed: existing.avatar_seed, playerToken, rejoined: true });
  }
  const used = new Set(list.map(p => p.seat_index));
  let seatIndex = -1;
  for (let i = 0; i < 64; i++) { if (!used.has(i)) { seatIndex = i; break; } }
  if (seatIndex < 0) return res.status(409).json({ error: "ROOM_FULL" });
  const avatarSeed = randomAvatarSeed();
  list.push({ room_code: payload.roomCode, player_id: payload.playerId, username: payload.username, avatar_seed: avatarSeed, seat_index: seatIndex, balance: 10, is_bankrupt: false, last_round_submitted: null });
  players.set(payload.roomCode, list);
  const playerToken = signPlayerToken(SERVER_SECRET, payload.roomCode, payload.playerId);
  return res.json({ roomCode: payload.roomCode, playerId: payload.playerId, seatIndex, avatarSeed, playerToken, rejoined: false });
});

app.get("/api/rooms/:code/bootstrap", (req, res) => {
  const roomCode = normalizeCode(req.params.code);
  const room = getRoom(roomCode);
  if (!room) return res.status(404).json({ error: "ROOM_NOT_FOUND" });
  const list = getPlayers(roomCode);
  if (room.round_deadline_at) {
    const deadline = new Date(room.round_deadline_at).getTime();
    if (Date.now() >= deadline) {
      list.forEach(p => {
        if (p.pending_submission && p.pending_submission.roundIndex === room.current_round_index) {
          p.balance = p.pending_submission.resulting_balance;
          p.is_bankrupt = p.pending_submission.bankrupt;
          delete p.pending_submission;
        }
      });
    }
  }
  const safeList = list.map(p => ({ player_id: p.player_id, username: p.username, avatar_seed: p.avatar_seed, seat_index: p.seat_index, balance: p.balance, is_bankrupt: p.is_bankrupt, last_round_submitted: p.last_round_submitted }));
  // Strip answer-revealing fields from quiz before shipping to clients, except for completed questions.
  const now = Date.now();
  const deadline = room.round_deadline_at ? new Date(room.round_deadline_at).getTime() : 0;
  const currentRoundEnded = room.round_deadline_at && now >= deadline;
  const safeQuiz = room.quiz_payload ? {
    ...room.quiz_payload,
    questions: (room.quiz_payload.questions || []).map((q, idx) => {
      if (idx < room.current_round_index || (idx === room.current_round_index && currentRoundEnded)) {
        return q;
      }
      return stripAnswersFromQuestion(q);
    })
  } : null;
  const safeRoom = {
    code: room.code,
    host_player_id: room.host_player_id,
    host_username: room.host_username,
    round_duration_sec: room.round_duration_sec,
    quiz_payload: safeQuiz,
    current_round_index: room.current_round_index,
    round_started_at: room.round_started_at,
    round_deadline_at: room.round_deadline_at,
    is_active: room.is_active,
    created_at: room.created_at
  };
  return res.json({ room: safeRoom, players: safeList });
});

app.post("/api/rounds/start", (req, res) => {
  const parsed = startRoundSchema.safeParse({ ...req.body, roomCode: normalizeCode(req.body?.roomCode) });
  if (!parsed.success) return res.status(400).json({ error: "INVALID_PAYLOAD", details: parsed.error.flatten() });
  const payload = parsed.data;
  const room = getRoom(payload.roomCode);
  if (!room) return res.status(404).json({ error: "ROOM_NOT_FOUND" });
  if (room.host_player_id !== payload.hostPlayerId) return res.status(403).json({ error: "NOT_HOST" });
  const headerSecret = req.get("x-host-secret") || "";
  if (!room.host_secret || headerSecret !== room.host_secret) return res.status(403).json({ error: "BAD_HOST_SECRET" });
  const now = Date.now();
  const deadlineAt = new Date(now + room.round_duration_sec * 1000).toISOString();
  room.current_round_index = payload.roundIndex;
  room.round_started_at = new Date(now).toISOString();
  room.round_deadline_at = deadlineAt;
  room.submit_mask = 0;
  room.win_mask = 0;
  return res.json({ started: { round_index: payload.roundIndex, round_deadline_at: deadlineAt } });
});

app.post("/api/submit-round", (req, res) => {
  const parsed = submitRoundSchema.safeParse({ ...req.body, roomCode: normalizeCode(req.body?.roomCode) });
  if (!parsed.success) return res.status(400).json({ error: "INVALID_PAYLOAD", details: parsed.error.flatten() });
  const payload = parsed.data;
  const room = getRoom(payload.roomCode);
  if (!room) return res.status(404).json({ error: "ROOM_NOT_FOUND" });

  // Verify player identity
  if (!verifyPlayerToken(SERVER_SECRET, payload.playerToken, payload.roomCode, payload.playerId)) {
    return res.status(403).json({ error: "BAD_PLAYER_TOKEN" });
  }

  const list = getPlayers(payload.roomCode);
  const player = list.find(p => p.player_id === payload.playerId);
  if (!player) return res.status(404).json({ error: "PLAYER_NOT_FOUND" });

  // Round-state guards
  if (room.current_round_index !== payload.roundIndex) {
    return res.status(409).json({ error: "WRONG_ROUND" });
  }
  if (!room.round_deadline_at) return res.status(409).json({ error: "ROUND_NOT_STARTED" });
  if (Date.now() > new Date(room.round_deadline_at).getTime()) {
    return res.status(409).json({ error: "ROUND_DEADLINE_PASSED" });
  }

  // Double-submit guard via per-player bit in submit_mask
  const bit = 1n << BigInt(player.seat_index);
  const mask = BigInt(room.submit_mask);
  if ((mask & bit) !== 0n) return res.status(409).json({ error: "ALREADY_SUBMITTED" });

  // Bet bounds vs balance
  if (payload.bet > player.balance) return res.status(400).json({ error: "BET_EXCEEDS_BALANCE" });
  if (player.is_bankrupt) return res.status(409).json({ error: "PLAYER_BANKRUPT" });

  // Authoritative hit-test against the RAW (un-stripped) quiz on the server.
  const question = room.quiz_payload?.questions?.[payload.roundIndex];
  const isWin = payload.click
    ? hitTestQuestion(question, payload.click, payload.gaugeValue ?? null)
    : false;

  const rngFactor = computeRngFactor(isWin);
  const rawDelta = isWin ? Math.round(payload.bet * rngFactor) : -payload.bet;
  const prevBalance = player.balance;
  const nextBalance = Math.max(0, prevBalance + rawDelta);
  const nextBankrupt = nextBalance === 0;
  const actualDelta = nextBalance - prevBalance;

  player.pending_submission = {
    resulting_is_win:      isWin,
    resulting_balance:     nextBalance,
    delta:                 actualDelta,
    rng_factor:            Number(rngFactor.toFixed(2)),
    anti_cheat:            false,
    bankrupt:              nextBankrupt,
    roundIndex:            payload.roundIndex,
  };

  player.last_round_submitted = payload.roundIndex;
  room.submit_mask = Number(mask | bit);
  if (isWin) room.win_mask = Number(BigInt(room.win_mask) | bit);

  return res.json({ result: player.pending_submission });
});

app.post("/api/rooms/cleanup", (req, res) => {
  const parsed = cleanupRoomSchema.safeParse({ ...req.body, roomCode: normalizeCode(req.body?.roomCode) });
  if (!parsed.success) return res.status(400).json({ error: "INVALID_PAYLOAD", details: parsed.error.flatten() });
  const payload = parsed.data;
  const room = getRoom(payload.roomCode);
  if (!room) return res.status(404).json({ error: "ROOM_NOT_FOUND" });
  if (room.host_player_id !== payload.hostPlayerId) return res.status(403).json({ error: "ONLY_HOST_CAN_CLEANUP" });
  const headerSecret = req.get("x-host-secret") || "";
  if (!room.host_secret || headerSecret !== room.host_secret) return res.status(403).json({ error: "BAD_HOST_SECRET" });
  const list = getPlayers(payload.roomCode);
  const now = new Date().toISOString();
  list.forEach(p => leaderboard.push({ room_code: payload.roomCode, username: p.username, avatar_seed: p.avatar_seed, final_balance: p.balance, total_rounds: 0, ended_at: now }));
  leaderboard.sort((a, b) => b.final_balance - a.final_balance);
  rooms.delete(payload.roomCode);
  players.delete(payload.roomCode);
  return res.json({ cleaned: true });
});

app.get("/api/leaderboard", (_req, res) => { return res.json({ leaderboard: leaderboard.slice(0, 100) }); });

app.use((_req, res) => { res.status(404).json({ error: "NOT_FOUND" }); });

const server = app.listen(config.port, () => {
  console.log(`Referee server running on port ${config.port}`);
  console.log(`Generated trace id sample: ${randomUUID()}`);
});

export { app, server };
