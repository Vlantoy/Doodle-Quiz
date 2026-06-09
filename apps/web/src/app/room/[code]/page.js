"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { cleanupRoom, deletePlayer, getBootstrap, joinRoom, startRound, submitRound, updatePlayerBalance } from "lib/api";
import { getOrCreateUser, saveUser, saveRoomState, getRoomState } from "lib/storage";
import { supabase, isMockMode } from "lib/supabaseClient";

import DoodleCanvas from "components/DoodleCanvas";

/*
  Phase lifecycle per round:
    lobby        – between rounds; player sets bet; host controls start
    active       – countdown running; canvas interactive; bet is locked
    won_waiting  – player hit target early; canvas FULLY OBSCURED; timer keeps ticking
    submitting   – timer hit 0; POST in flight
    results      – server response received; overlay shows gain/loss/rng
    bankrupt     – player balance reached 0; eliminated
*/
const ConfettiExplosion = () => {
  const particles = Array.from({ length: 45 }).map((_, i) => {
    const angle = (i * 360) / 45 + (Math.random() * 10 - 5);
    const rad = (angle * Math.PI) / 180;
    const distance = 40 + Math.random() * 120;
    const tx = Math.cos(rad) * distance;
    const ty = Math.sin(rad) * distance;
    const size = 6 + Math.random() * 8;
    const color = ["#ff8f9f", "#ffd7ba", "#c6f7e2", "#c8e6ff", "#ffeb3b", "#7c3aed"][i % 6];
    const shape = i % 3 === 0 ? "circle" : i % 3 === 1 ? "square" : "triangle";
    return { tx, ty, size, color, shape, id: i };
  });

  return (
    <div style={{ position: "absolute", top: "50%", left: "50%", pointerEvents: "none", zIndex: 100 }}>
      {particles.map((p) => (
        <div
          key={p.id}
          className={`confetti-particle ${p.shape}`}
          style={{
            "--tx": `${p.tx}px`,
            "--ty": `${p.ty}px`,
            "--color": p.color,
            width: p.size,
            height: p.size,
          }}
        />
      ))}
    </div>
  );
};

function pointInPolygon(rx, ry, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x, yi = points[i].y;
    const xj = points[j].x, yj = points[j].y;
    if (((yi > ry) !== (yj > ry)) && (rx < ((xj - xi) * (ry - yi)) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

export default function RoomPage({ params }) {
  const roomCode = String(params.code || "").toUpperCase();
  const router = useRouter();
  const [user, setUser] = useState(null);
  const hostSecret = typeof window !== "undefined" ? (getRoomState(roomCode)?.hostSecret ?? null) : null;

  const [bootstrap,  setBootstrap]  = useState(null);
  const [phase,      setPhase]      = useState("lobby");
  const [bet,        setBet]        = useState(1);
  const [remainingMs,setRemainingMs]= useState(0);
  const [roundResult,setRoundResult]= useState(null);
  const [msg,        setMsg]        = useState("Joining room...");
  const [showOverlay,setShowOverlay]= useState(true);
  const [showUsernameModal, setShowUsernameModal] = useState(false);
  const [usernameInput, setUsernameInput] = useState("");
  const [showFinalLeaderboard, setShowFinalLeaderboard] = useState(true);
  const [confettiActive, setConfettiActive] = useState(false);
  const [hasConfirmedName, setHasConfirmedName] = useState(false);
  const [reviewQuestionIndex, setReviewQuestionIndex] = useState(null);

  // Refs keep values fresh inside setInterval callbacks (avoid stale closures)
  const bootstrapRef   = useRef(null);
  const phaseRef       = useRef("lobby");
  const betRef         = useRef(1);
  const localWinRef    = useRef(false);
  const startMsRef     = useRef(null);
  const submittedRef   = useRef(false);
  const timerRef       = useRef(null);
  const prevDeadlineRef= useRef(null);
  const joinedRef      = useRef(false);
  const userRef        = useRef(null);
  const isHostRef      = useRef(false);
  const autoTimerRef   = useRef(null);
  const playerTokenRef = useRef(null);   // HMAC token from join — required by /submit-round
  const lastClickRef   = useRef(null);   // {rx, ry} of player's last canvas click this round
  const lastGaugeRef   = useRef(null);   // gauge value at click time (or null)
  const [autoSec, setAutoSec] = useState(0);
  const [playerClicks, setPlayerClicks] = useState([]);

  function syncPhase(p) { setPhase(p); phaseRef.current = p; }
  function syncBet(v)   { setBet(v);   betRef.current   = v; }

  // Derived render values (from state)
  const room      = bootstrap?.room;
  const players   = bootstrap?.players ?? [];
  const me        = players.find(p => p.player_id === user?.playerId) ?? null;
  const isHost    = !!(room && user && room.host_player_id === user.playerId);
  const totalQ    = room?.quiz_payload?.questions?.length ?? 0;
  const activeQuestionIndex = reviewQuestionIndex !== null ? reviewQuestionIndex : (room?.current_round_index ?? 0);
  const question  = room?.quiz_payload?.questions?.[activeQuestionIndex] ?? null;
  const myBalance = me?.balance ?? 10;
  const isBankrupt= me?.is_bankrupt ?? false;
  const isGameFinished = room && room.current_round_index + 1 >= totalQ && phase === "results";
  const sortedPlayers = [...players].sort((a, b) => b.balance - a.balance);
  const restPlayers = sortedPlayers.slice(3);
  const userRankIndex = sortedPlayers.findIndex(p => p.player_id === user?.playerId);

  async function refreshBootstrap(silent = false) {
    try {
      const data = await getBootstrap(roomCode);
      bootstrapRef.current = data;
      setBootstrap(data);
      return data;
    } catch (err) {
      if (!silent) setMsg(`Sync error: ${err.message}`);
      return null;
    }
  }

  // ── Load user from localStorage (client-only, avoids SSR null) ─────────────
  useEffect(() => { const u = getOrCreateUser(); setUser(u); userRef.current = u; }, []);

  useEffect(() => {
    if (user && !usernameInput) {
      setUsernameInput(user.username || "");
    }
  }, [user]);

  // ── Keep isHostRef in sync ────────────────────────────────────────────────────
  useEffect(() => { isHostRef.current = isHost; }, [isHost]);

  // ── Initial join ──────────────────────────────────────────────────────────────
  useEffect(() => {
    refreshBootstrap(true);
  }, []);

  useEffect(() => {
    if (isGameFinished) {
      setShowFinalLeaderboard(true);
      const timer = setTimeout(() => {
        setConfettiActive(true);
      }, 850);
      return () => clearTimeout(timer);
    } else {
      setConfettiActive(false);
    }
  }, [isGameFinished]);

  function handleUsernameSubmit(e) {
    e.preventDefault();
    const trimmed = usernameInput.trim();
    if (!trimmed) return;
    const updatedUser = { ...user, username: trimmed };
    saveUser(updatedUser);
    setUser(updatedUser);
    userRef.current = updatedUser;
    setHasConfirmedName(true);
    setShowUsernameModal(false);
  }

  useEffect(() => {
    if (!user || !bootstrap) return;
    const room = bootstrap.room;
    const isHost = !!(room && user && room.host_player_id === user.playerId);
    if (isHost) {
      joinedRef.current = true;
      setMsg("Spectating as Host 👑");
      return;
    }

    if (!hasConfirmedName) {
      setShowUsernameModal(true);
      return;
    }

    if (joinedRef.current) return;
    joinedRef.current = true;
    joinRoom({ roomCode, playerId: user.playerId, username: user.username })
      .then(res => {
        playerTokenRef.current = res?.playerToken ?? null;
        saveRoomState(roomCode, { playerToken: res?.playerToken ?? null, joinedAt: Date.now() });
        return refreshBootstrap();
      })
      .then(() => setMsg("Joined room successfully!"))
      .catch(err => { joinedRef.current = false; setMsg(`Join failed: ${err.message}`); });
  }, [user, bootstrap, hasConfirmedName]);

  // ── Auto-advance slideshow (host side) ──────────────────────────────────────
  useEffect(() => {
    clearInterval(autoTimerRef.current);
    setAutoSec(0);
    if (phase !== "results") return;
    if (!isHostRef.current) return;
    const snap = bootstrapRef.current || bootstrap;
    const snapRoom = snap?.room;
    if (!snapRoom) return;
    const nextIdx = snapRoom.current_round_index + 1;
    const total = snapRoom.quiz_payload?.questions?.length ?? 0;
    if (nextIdx >= total) return; // last question — no auto-advance
    let sec = 3;
    setAutoSec(sec);
    autoTimerRef.current = setInterval(() => {
      sec -= 1;
      setAutoSec(sec);
      if (sec <= 0) {
        clearInterval(autoTimerRef.current);
        const u = userRef.current;
        if (!u) return;
        startRound({ roomCode, hostPlayerId: u.playerId, roundIndex: nextIdx }, hostSecret)
          .then(() => refreshBootstrap())
          .catch(err => setMsg(`Auto-advance failed: ${err.message}`));
      }
    }, 1000);
    return () => clearInterval(autoTimerRef.current);
  }, [phase]);

  // ── Auto-end round early when all players have submitted ──────────────────────
  useEffect(() => {
    if (!isHost || phase !== "active" || !room) return;

    const activePlayers = players.filter(p => !p.is_bankrupt);
    if (activePlayers.length === 0) return;

    const allSubmitted = activePlayers.every(p => p.last_round_submitted === room.current_round_index);
    if (allSubmitted) {
      const nowIso = new Date().toISOString();
      if (isMockMode) {
        const rooms = JSON.parse(localStorage.getItem("cutequiz:mock_rooms") || "[]");
        const idx = rooms.findIndex(r => r.code === roomCode);
        if (idx !== -1) {
          rooms[idx].round_deadline = nowIso;
          localStorage.setItem("cutequiz:mock_rooms", JSON.stringify(rooms));
          window.dispatchEvent(new Event("storage"));
        }
      } else {
        supabase.from("rooms")
          .update({ round_deadline: nowIso })
          .eq("code", roomCode)
          .then(() => refreshBootstrap());
      }
    }
  }, [bootstrap, isHost, phase, roomCode, room, players]);

  // ── Fallback Poll — slower now as we use Realtime for instant synchronization ──
  useEffect(() => {
    const id = setInterval(() => {
      const p = phaseRef.current;
      if (p === "active" || p === "won_waiting" || p === "submitting") return;
      refreshBootstrap(true);
    }, 5000);
    return () => clearInterval(id);
  }, []);

  // ── HTML5 storage event sync (for offline local Sandbox testing across tabs) ──
  useEffect(() => {
    if (!isMockMode) return;
    const handleStorageChange = (e) => {
      if (e.key === "cutequiz:mock_rooms" || e.key === "cutequiz:mock_players") {
        refreshBootstrap(true);
      }
    };
    window.addEventListener("storage", handleStorageChange);
    return () => window.removeEventListener("storage", handleStorageChange);
  }, []);

  // ── Supabase Realtime WebSocket subscription (for live instant sync) ──────────
  useEffect(() => {
    if (isMockMode || !roomCode) return;

    const channel = supabase
      .channel(`room-realtime:${roomCode}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "rooms", filter: `code=eq.${roomCode}` },
        () => {
          refreshBootstrap(true);
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "players", filter: `room_code=eq.${roomCode}` },
        () => {
          refreshBootstrap(true);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [roomCode]);

  // ── Cleanup on browser window tab close (beforeunload) ────────────────────────
  useEffect(() => {
    const handleUnload = () => {
      if (!user || !roomCode) return;
      if (isMockMode) {
        // Synchronous cleanup for offline test
        if (isHostRef.current) {
          const rooms = JSON.parse(localStorage.getItem("cutequiz:mock_rooms") || "[]");
          localStorage.setItem("cutequiz:mock_rooms", JSON.stringify(rooms.filter(r => r.code !== roomCode)));
          const players = JSON.parse(localStorage.getItem("cutequiz:mock_players") || "[]");
          localStorage.setItem("cutequiz:mock_players", JSON.stringify(players.filter(p => p.room_code !== roomCode)));
        } else {
          const players = JSON.parse(localStorage.getItem("cutequiz:mock_players") || "[]");
          localStorage.setItem("cutequiz:mock_players", JSON.stringify(players.filter(p => !(p.id === user.playerId && p.room_code === roomCode))));
        }
      } else {
        // Live Supabase API call using fetch keepalive: true (keeps request alive after tab closes)
        const table = isHostRef.current ? "rooms" : "players";
        const filterQuery = isHostRef.current ? `code=eq.${roomCode}` : `id=eq.${user.playerId}&room_code=eq.${roomCode}`;
        const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${table}?${filterQuery}`;
        const headers = {
          "apikey": process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
          "Authorization": `Bearer ${process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY}`,
        };
        fetch(url, { method: "DELETE", headers, keepalive: true });
      }
    };

    window.addEventListener("beforeunload", handleUnload);
    return () => window.removeEventListener("beforeunload", handleUnload);
  }, [user, roomCode]);

  // ── Detect new round (deadline changed) → launch countdown ───────────────────
  useEffect(() => {
    if (!room?.round_deadline_at) return;
    if (room.round_deadline_at === prevDeadlineRef.current) return;
    prevDeadlineRef.current = room.round_deadline_at;

    submittedRef.current = false;
    localWinRef.current  = false;
    lastClickRef.current = null;
    lastGaugeRef.current = null;
    startMsRef.current   = Date.now();
    setRoundResult(null);
    setReviewQuestionIndex(null);
    setPlayerClicks([]);
    syncPhase("active");
    setShowOverlay(true);
    setMsg("Round started! Find the hidden target zone.");

    clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      const left = new Date(room.round_deadline_at).getTime() - Date.now();
      setRemainingMs(Math.max(0, left));
      if (left <= 0) {
        clearInterval(timerRef.current);
        if (submittedRef.current) {
          syncPhase(roundResult?.bankrupt ? "bankrupt" : "results");
          refreshBootstrap(true);
        } else {
          fireSubmit();
        }
      }
    }, 100);

    return () => clearInterval(timerRef.current);
  }, [room?.round_deadline_at]);

  function onCanvasSolve(payload) {
    if (!payload || phaseRef.current !== "active") return;

    // Check if it is a multi-click question (more than 1 correct zones)
    const correctZones = question?.elements?.filter(el =>
      (el.type === "PRECISION_TARGET" || el.type === "FREEFORM_ZONE") && el.role !== "DECOY"
    ) ?? [];
    const isMultiple = correctZones.length > 1;

    if (isMultiple) {
      setPlayerClicks(prev => {
        if (prev.length >= correctZones.length) return prev;
        const newClicks = [...prev, { rx: payload.rx, ry: payload.ry }];
        return newClicks;
      });
      lastGaugeRef.current = typeof payload.gaugeValue === "number" ? payload.gaugeValue : null;
    } else {
      lastClickRef.current = { rx: payload.rx, ry: payload.ry };
      lastGaugeRef.current = typeof payload.gaugeValue === "number" ? payload.gaugeValue : null;
      localWinRef.current = payload.isLocalHit;
      syncPhase("won_waiting");

      // Update submission status in database to notify the host
      const currentMe = bootstrap?.players?.find(p => p.player_id === user?.playerId);
      if (currentMe && room) {
        updatePlayerBalance(user.playerId, roomCode, currentMe.balance, currentMe.is_bankrupt, room.current_round_index).then();
      }
    }
  }

  const handleMultiSubmit = () => {
    const correctZones = question?.elements?.filter(el =>
      (el.type === "PRECISION_TARGET" || el.type === "FREEFORM_ZONE") && el.role !== "DECOY"
    ) ?? [];

    if (playerClicks.length !== correctZones.length) return;

    let won = false;
    if (question?.requireSequence) {
      // Click in sequence order (Click i matches Zone i)
      let seqOk = true;
      for (let i = 0; i < correctZones.length; i++) {
        const click = playerClicks[i];
        const zone = correctZones[i];
        let hit = false;
        if (zone.type === "PRECISION_TARGET") {
          if (
            click.rx >= zone.x_ratio && click.rx <= zone.x_ratio + zone.w_ratio &&
            click.ry >= zone.y_ratio && click.ry <= zone.y_ratio + zone.h_ratio
          ) { hit = true; }
        } else if (zone.type === "FREEFORM_ZONE") {
          if (zone.points_ratio?.length >= 3 && pointInPolygon(click.rx, click.ry, zone.points_ratio)) {
            hit = true;
          }
        }
        if (!hit) {
          seqOk = false;
          break;
        }
      }
      won = seqOk;
    } else {
      // Click in any order (each correct zone matched exactly once)
      const visited = new Array(correctZones.length).fill(false);
      function match(clickIdx) {
        if (clickIdx === playerClicks.length) return true;
        const click = playerClicks[clickIdx];
        for (let zIdx = 0; zIdx < correctZones.length; zIdx++) {
          if (visited[zIdx]) continue;
          const zone = correctZones[zIdx];
          let hit = false;
          if (zone.type === "PRECISION_TARGET") {
            if (
              click.rx >= zone.x_ratio && click.rx <= zone.x_ratio + zone.w_ratio &&
              click.ry >= zone.y_ratio && click.ry <= zone.y_ratio + zone.h_ratio
            ) { hit = true; }
          } else if (zone.type === "FREEFORM_ZONE") {
            if (zone.points_ratio?.length >= 3 && pointInPolygon(click.rx, click.ry, zone.points_ratio)) {
              hit = true;
            }
          }
          if (hit) {
            visited[zIdx] = true;
            if (match(clickIdx + 1)) return true;
            visited[zIdx] = false;
          }
        }
        return false;
      }
      won = match(0);
    }

    const gaugeEl = question?.elements?.find(el => el.type === "GAUGE_BLOCK");
    const gaugeValue = typeof lastGaugeRef.current === "number" ? lastGaugeRef.current : 50;
    const gaugeOk = !gaugeEl ||
      typeof gaugeEl.correctMin !== "number" ||
      (gaugeValue >= gaugeEl.correctMin && gaugeValue <= gaugeEl.correctMax);

    const finalWin = won && gaugeOk;

    lastClickRef.current = playerClicks[0] || { rx: 0.5, ry: 0.5 };
    localWinRef.current = finalWin;
    syncPhase("won_waiting");

    // Update submission status in database to notify the host
    const currentMe = bootstrap?.players?.find(p => p.player_id === user?.playerId);
    if (currentMe && room) {
      updatePlayerBalance(user.playerId, roomCode, currentMe.balance, currentMe.is_bankrupt, room.current_round_index).then();
    }
  };

  // ── Batch submit — reads refs, NOT stale state closure ───────────────────────
  async function fireSubmit() {
    if (submittedRef.current) return;
    submittedRef.current = true;

    const snap     = bootstrapRef.current;
    const snapMe   = snap?.players?.find(p => p.player_id === user?.playerId);
    const snapRoom = snap?.room;

    if (!snapMe || !snapRoom) { syncPhase("results"); return; }
    if (snapMe.is_bankrupt)   { syncPhase("bankrupt"); return; }

    syncPhase("submitting");
    const clampedBet = Math.max(1, Math.min(snapMe.balance, betRef.current));
    const won        = localWinRef.current ?? false;

    const rawDelta = won ? clampedBet : -clampedBet;
    const prevBalance = snapMe.balance;
    const nextBalance = Math.max(0, prevBalance + rawDelta);
    const nextBankrupt = nextBalance === 0;
    const actualDelta = nextBalance - prevBalance;

    const result = {
      resulting_is_win:      won,
      resulting_balance:     nextBalance,
      delta:                 actualDelta,
      rng_factor:            1.0,
      anti_cheat:            false,
      bankrupt:              nextBankrupt,
      roundIndex:            snapRoom.current_round_index,
    };

    try {
      // Direct client update to Supabase players table
      await updatePlayerBalance(
        user.playerId,
        roomCode,
        nextBalance,
        nextBankrupt,
        snapRoom.current_round_index
      );

      saveRoomState(roomCode, {
        roundIndex: snapRoom.current_round_index,
        balance:    nextBalance,
        lastSubmit: Date.now(),
      });

      setRoundResult(result);
      syncPhase(nextBankrupt ? "bankrupt" : "results");
      await refreshBootstrap();
      setMsg("Round submitted successfully.");
    } catch (err) {
      setMsg(`Submit error: ${err.message}`);
      syncPhase("results");
    }
  }

  // ── Host actions ──────────────────────────────────────────────────────────────
  async function hostStartQuiz() {
    if (!isHost || !room) return;
    try {
      await startRound({ roomCode, hostPlayerId: user.playerId, roundIndex: 0 }, hostSecret);
      await refreshBootstrap();
    } catch (err) { setMsg(`Start failed: ${err.message}`); }
  }

  const isCreator = false;
  const canvasDisabled = phase !== "active" || isBankrupt || isHost;
  const overlayBase = {
    position: "absolute",
    inset: 0,
    zIndex: 100,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    textAlign: "center",
    padding: 24,
    boxSizing: "border-box",
    color: "#fff",
    fontFamily: "Fredoka, sans-serif"
  };

  async function endRoom() {
    if (!roomCode || !user) return;
    try {
      await cleanupRoom({ roomCode, hostPlayerId: user.playerId }, hostSecret);
    } catch (err) {
      console.error("Failed to end room:", err);
    }
    router.push("/");
  }

  async function handleLeave() {
    if (!roomCode || !user) return;
    try {
      if (isHost) {
        await cleanupRoom({ roomCode, hostPlayerId: user.playerId }, hostSecret);
      } else {
        await deletePlayer(user.playerId, roomCode);
      }
    } catch (err) {
      console.error("Failed to leave room:", err);
    }
    router.push("/");
  }

  const hasGauge = question?.elements?.some(el => el.type === "GAUGE_BLOCK");
  const canvasMaxWidth = hasGauge ? "calc(100vh - 110px)" : "calc(100vh - 55px)";

  return (
    <>
      <main className="room-shell" style={{ "--canvas-max-width": canvasMaxWidth }}>
        <section className="room-grid">
          {/* ── Canvas area (Left Column: Full Height 1:1, pushed to left) ────────────────────── */}
          <div className="room-canvas-col">
            <div className="room-canvas-wrapper">
              {question ? (
                <DoodleCanvas
                  question={question}
                  disabled={canvasDisabled}
                  onSolve={onCanvasSolve}
                  isCreator={false}
                  revealAnswers={phase === "results" || phase === "bankrupt" || isGameFinished}
                  playerClicks={playerClicks}
                />
              ) : (
                <div className="doodle-board" style={{ height: "100%", display: "grid", placeItems: "center", opacity: 0.4 }}>
                  <p>No question active</p>
                </div>
              )}

              {/* SUBMITTED BLACKOUT: prevent answer leaking to nearby players */}
              {phase === "won_waiting" && (
                <div style={{ ...overlayBase, background: "linear-gradient(135deg,#1e1232f0,#2d1b4ef0)" }}>
                  <div>
                    <div style={{ fontSize: "3.5rem", lineHeight: 1 }}>📥</div>
                    <h2 style={{ fontFamily: "Itim, cursive", margin: "12px 0 6px", fontSize: "1.8rem" }}>
                      SUBMITTED!
                    </h2>
                    <p style={{ opacity: 0.8 }}>Waiting for other players...</p>
                    <p style={{ opacity: 0.45, fontSize: "0.9rem" }}>⏱ {(remainingMs / 1000).toFixed(1)}s left</p>
                  </div>
                </div>
              )}

              {/* TIME OUT / SUBMITTING */}
              {phase === "submitting" && (
                <div style={{ ...overlayBase, background: "linear-gradient(135deg,#1a1a1af0,#2f2a3cf0)" }}>
                  <div>
                    <div style={{ fontSize: "3rem" }}>⏰</div>
                    <h2 style={{ fontFamily: "Itim, cursive", margin: "12px 0 6px" }}>TIME OUT!</h2>
                    <p style={{ opacity: 0.7 }}>Verifying your nhân phẩm...</p>
                    <p style={{ opacity: 0.4, fontSize: "0.85rem" }}>Syncing with server...</p>
                  </div>
                </div>
              )}

              {/* ROUND RESULTS */}
              {phase === "results" && roundResult && showOverlay && (
                <div style={{
                  ...overlayBase,
                  background: roundResult.resulting_is_win
                    ? "linear-gradient(135deg,#064e3bf0,#065f46f0)"
                    : "linear-gradient(135deg,#7f1d1df0,#991b1bf0)",
                }}>
                  <div>
                    {roundResult.resulting_is_win ? (
                      <>
                        <div style={{ fontSize: "3rem" }}>✨</div>
                        <h2 style={{ fontFamily: "Itim, cursive", margin: "10px 0 6px" }}>ROUND WIN!</h2>
                        <p>RNG ×{Number(roundResult.rng_factor ?? 0).toFixed(2)}</p>
                        <p style={{ fontSize: "1.5rem", fontWeight: "bold" }}>+{roundResult.delta} coins</p>
                      </>
                    ) : (
                      <>
                        <div style={{ fontSize: "3rem" }}>{roundResult.anti_cheat ? "🚨" : "💀"}</div>
                        <h2 style={{ fontFamily: "Itim, cursive", margin: "10px 0 6px" }}>
                          {roundResult.anti_cheat ? "ANTI-CHEAT TRIGGERED" : "ROUND LOSS"}
                        </h2>
                        {roundResult.anti_cheat && (
                          <p style={{ fontSize: "0.85rem", opacity: 0.75 }}>Bet was invalid. Balance reset to 0.</p>
                        )}
                        <p style={{ fontSize: "1.5rem", fontWeight: "bold" }}>{roundResult.delta} coins</p>
                      </>
                    )}
                    <p style={{ marginTop: 10, opacity: 0.85 }}>
                      Balance: <strong>{roundResult.resulting_balance}</strong> coins
                    </p>

                    <button
                      type="button"
                      className="btn secondary"
                      style={{
                        marginTop: 10,
                        background: "rgba(255, 255, 255, 0.2)",
                        color: "white",
                        borderColor: "rgba(255, 255, 255, 0.4)",
                        width: "100%",
                        fontFamily: "Patrick Hand, cursive",
                      }}
                      onClick={() => setShowOverlay(false)}
                    >
                      👁 View Canvas &amp; Answer
                    </button>

                    {isHost && room?.current_round_index + 1 >= totalQ ? (
                      <button type="button" className="btn danger" style={{ marginTop: 14 }} onClick={endRoom}>🏁 End Room</button>
                    ) : isHost && autoSec > 0 ? (
                      <p style={{ marginTop: 12, opacity: 0.75, fontSize: "0.95rem" }}>⏭ Next question in <strong>{autoSec}s</strong>...</p>
                    ) : (
                      <p style={{ marginTop: 12, opacity: 0.5, fontSize: "0.85rem" }}>Waiting for next question...</p>
                    )}
                  </div>
                </div>
              )}

              {/* BANKRUPT */}
              {phase === "bankrupt" && showOverlay && (
                <div style={{ ...overlayBase, background: "linear-gradient(135deg,#7f1d1df0,#450a0af0)" }}>
                  <div>
                    <div style={{ fontSize: "3.5rem" }}>💸</div>
                    <h2 style={{ fontFamily: "Itim, cursive", margin: "12px 0 6px" }}>BANKRUPT!</h2>
                    <p>You ran out of coins and are eliminated.</p>
                    <p style={{ opacity: 0.55, fontSize: "0.85rem" }}>Spectate the remaining rounds.</p>
                    <button
                      type="button"
                      className="btn secondary"
                      style={{
                        marginTop: 14,
                        background: "rgba(255, 255, 255, 0.2)",
                        color: "white",
                        borderColor: "rgba(255, 255, 255, 0.4)",
                        width: "100%",
                        fontFamily: "Patrick Hand, cursive",
                      }}
                      onClick={() => setShowOverlay(false)}
                    >
                      👁 View Canvas &amp; Answer
                    </button>
                  </div>
                </div>
              )}

              {/* FLOATING SHOW RESULTS BUTTON */}
              {!showOverlay && (phase === "results" || phase === "bankrupt") && (
                <button
                  type="button"
                  className="btn secondary"
                  style={{
                    position: "absolute",
                    top: 12,
                    right: 12,
                    zIndex: 15,
                    boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
                    fontFamily: "Patrick Hand, cursive",
                    padding: "6px 12px",
                  }}
                  onClick={() => setShowOverlay(true)}
                >
                  📊 Show Stats
                </button>
              )}
            </div>
          </div>

          {/* ── Side panel (Right Column) ─────────────────────────────────────────────────────── */}
          <div className="room-sidebar-col">
            {/* Card 1: Metadata & Prompt */}
            <article className="card grid" style={{ gap: 10, padding: "12px 14px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                <h2 className="title" style={{ fontSize: "1.4rem", margin: 0 }}>
                  Room <span style={{ color: "#ff8f9f" }}>{roomCode}</span>
                </h2>
                <button type="button" onClick={handleLeave} className="btn secondary" style={{ padding: "4px 10px", fontSize: "0.85rem" }}>Leave</button>
              </div>

              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <span className="badge">⏱ {(remainingMs / 1000).toFixed(1)}s</span>
                <span className="badge">Q {(room?.current_round_index ?? 0) + 1}/{totalQ || "?"}</span>
                {!isHost && <span className="badge">💰 {myBalance} coins</span>}
                {isHost && <span className="badge" style={{ background: "#c6f7e2" }}>HOST 👑</span>}
                {!isHost && isBankrupt && <span className="badge" style={{ background: "#ff6b6b", color: "white" }}>BANKRUPT</span>}
              </div>

              <div style={{ borderTop: "2px dashed #ccc", paddingTop: 8, marginTop: 4 }}>
                <h3 style={{ fontSize: "0.95rem", margin: "0 0 6px", color: "var(--ink)", fontFamily: "Fredoka, sans-serif" }}>
                  🎯 Câu hỏi:
                </h3>
                <p style={{ margin: 0, fontSize: "0.95rem", fontWeight: "bold", lineHeight: 1.4 }}>
                  {isHost ? (
                    phase === "lobby" ? `📢 Quiz Set: ${room?.quiz_payload?.title || "Untitled"}` : (question?.prompt || "Active Round")
                  ) : (
                    phase === "lobby" ? "⏳ Waiting for host to start a round..." : (question?.prompt || "⏳ Waiting for host to start a round...")
                  )}
                </p>

                {isGameFinished && !showFinalLeaderboard && (
                  <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
                    <button
                      type="button"
                      className="btn secondary"
                      style={{ padding: "3px 8px", fontSize: "0.80rem" }}
                      disabled={activeQuestionIndex === 0}
                      onClick={() => setReviewQuestionIndex(activeQuestionIndex - 1)}
                    >
                      ◀ Trước
                    </button>
                    <span style={{ fontSize: "0.85rem", fontFamily: "Fredoka, sans-serif", fontWeight: "bold" }}>
                      Câu {activeQuestionIndex + 1}/{totalQ}
                    </span>
                    <button
                      type="button"
                      className="btn secondary"
                      style={{ padding: "3px 8px", fontSize: "0.80rem" }}
                      disabled={activeQuestionIndex === totalQ - 1}
                      onClick={() => setReviewQuestionIndex(activeQuestionIndex + 1)}
                    >
                      Sau ▶
                    </button>
                  </div>
                )}
              </div>
            </article>

            {/* Host Controls for Lobby & Results */}
            {isHost && (phase === "lobby" || phase === "results") && (
              <div className="card" style={{ background: "#fff8e8", border: "2px dashed #2f2a3c", padding: "10px 12px" }}>
                <h4 style={{ margin: "0 0 6px", fontSize: "1.05rem" }}>👑 Host Controls</h4>
                {phase === "lobby" && !room?.round_deadline_at && (
                  <button type="button" className="btn" style={{ width: "100%" }} onClick={hostStartQuiz}>
                    🚀 Start Quiz
                  </button>
                )}
                {phase === "results" && room?.current_round_index + 1 < totalQ && (
                  <p style={{ margin: 0, opacity: 0.8, fontSize: "0.85rem" }}>Next round will start automatically in {autoSec}s...</p>
                )}
                {phase === "results" && room?.current_round_index + 1 >= totalQ && (
                  <p style={{ margin: 0, opacity: 0.8, fontSize: "0.85rem" }}>Quiz completed! Spectate the final leaderboard.</p>
                )}
              </div>
            )}

            {/* Player Lobby/Results Status */}
            {!isHost && (phase === "lobby" || phase === "results") && !isBankrupt && (
              <div className="card" style={{ background: "#f3f4f6", border: "2px dashed #ccc", padding: "10px 12px" }}>
                <h4 style={{ margin: "0 0 4px", fontSize: "1.05rem" }}>⏳ Status</h4>
                {phase === "lobby" ? (
                  <p style={{ margin: 0, opacity: 0.7, fontSize: "0.85rem" }}>Waiting for host to start the quiz...</p>
                ) : (
                  <p style={{ margin: 0, opacity: 0.7, fontSize: "0.85rem" }}>Round ended. Waiting for next question...</p>
                )}
              </div>
            )}

            {/* Player Active Betting Panel */}
            {!isHost && phase === "active" && !isBankrupt && (() => {
              const correctZones = question?.elements?.filter(el =>
                (el.type === "PRECISION_TARGET" || el.type === "FREEFORM_ZONE") && el.role !== "DECOY"
              ) ?? [];
              const isMultiple = correctZones.length > 1;

              return (
                <div className="card" style={{ background: "#fff8e8", border: "2px dashed #2f2a3c", padding: "10px 12px" }}>
                  <h4 style={{ margin: "0 0 6px", fontSize: "1.05rem" }}>💰 Place Your Bet</h4>
                  <p style={{ margin: "0 0 6px", fontSize: "0.82rem" }}>
                    Balance: <strong>{myBalance}</strong> · Bet: 1–{myBalance}
                  </p>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={myBalance}
                    value={bet}
                    onChange={e => syncBet(Math.max(1, Math.min(myBalance, Number(e.target.value) || 1)))}
                  />
                  {isMultiple ? (
                    <div style={{ marginTop: 8 }}>
                      <p style={{ margin: "0 0 8px", fontWeight: "bold", color: "#7c3aed", fontSize: "0.85rem", lineHeight: 1.4 }}>
                        🧩 YÊU CẦU CLICK ĐÚNG THỨ TỰ:
                        <br />
                        Hãy click vào các target zone theo thứ tự từ 1 đến {correctZones.length}!
                      </p>
                      <div style={{ fontSize: "0.82rem", marginBottom: 8, opacity: 0.8 }}>
                        Đã click: <strong>{playerClicks.length} / {correctZones.length}</strong>
                      </div>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button type="button" className="btn secondary" style={{ flex: 1, padding: "5px 10px" }}
                          onClick={() => setPlayerClicks([])} disabled={playerClicks.length === 0}>
                          Xóa (Clear)
                        </button>
                        <button type="button" className="btn" style={{ flex: 1, padding: "5px 10px" }}
                          onClick={handleMultiSubmit} disabled={playerClicks.length !== correctZones.length}>
                          Gửi đáp án 🚀
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p style={{ margin: "8px 0 0", opacity: 0.6, fontSize: "0.82rem" }}>
                      Adjust your bet, then click on the canvas to submit!
                    </p>
                  )}
                </div>
              );
            })()}

            {/* Host Active Status */}
            {isHost && phase === "active" && (
              <div className="card" style={{ background: "#c6f7e2", borderStyle: "dashed", padding: "10px 12px" }}>
                <h4 style={{ margin: "0 0 4px", fontSize: "1.05rem" }}>🎯 Round Active</h4>
                <p style={{ margin: 0, fontSize: "0.85rem", opacity: 0.8 }}>Players are currently making their bets and guesses.</p>
              </div>
            )}

            {/* Host: end room */}
            {isHost && (phase === "lobby" || phase === "results") && (
              <button type="button" className="btn danger" onClick={endRoom}>🏁 End Room &amp; Archive</button>
            )}

            {/* Display the note card if present and round is over / reviewing */}
            {(phase === "results" || phase === "bankrupt" || isGameFinished) && question?.note && (
              <div className="card" style={{
                background: "#fef9c3",
                borderColor: "var(--ink)",
                borderWidth: 3,
                borderRadius: 18,
                boxShadow: "4px 4px 0 #0000001f",
                fontFamily: "Fredoka, sans-serif",
                textAlign: "left",
                padding: "10px 14px",
              }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                  <span style={{ fontSize: "1.2rem" }}>💡</span>
                  <strong style={{ color: "var(--ink)", fontSize: "0.95rem", fontFamily: "Itim, cursive" }}>
                    Giải thích / Ghi chú:
                  </strong>
                </div>
                <p style={{ margin: 0, color: "var(--ink)", fontSize: "0.85rem", lineHeight: 1.4, whiteSpace: "pre-wrap" }}>
                  {question.note}
                </p>
              </div>
            )}

            {/* Players Scoreboard */}
            <div className="card" style={{ padding: "10px 12px" }}>
              {isGameFinished ? (
                <div>
                  <h4 style={{ margin: "0 0 10px", textAlign: "center", fontSize: "1.2rem", color: "#7c3aed", fontFamily: "Itim, cursive" }}>🏆 Final Standings</h4>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {[...players]
                      .sort((a, b) => b.balance - a.balance)
                      .map((p, rankIdx) => {
                        const medal = rankIdx === 0 ? "🥇" : rankIdx === 1 ? "🥈" : rankIdx === 2 ? "🥉" : `${rankIdx + 1}.`;
                        const isMe = p.player_id === user?.playerId;
                        return (
                          <div key={p.player_id} style={{
                            display: "flex", alignItems: "center", gap: 10, padding: "6px 10px",
                            background: isMe ? "#f5f3ff" : "#fff",
                            border: isMe ? "2.5px solid #7c3aed" : "2px solid #2f2a3c",
                            borderRadius: 12,
                            fontSize: "0.85rem",
                          }}>
                            <span style={{ fontSize: "1.1rem", fontWeight: "bold", width: 24, textAlign: "center" }}>{medal}</span>
                            <div style={{ flex: 1 }}>
                              <strong>{p.username}</strong>
                              {isMe && <span style={{ fontSize: "0.75rem", color: "#7c3aed" }}> (you)</span>}
                            </div>
                            <div style={{ fontWeight: "bold" }}>💰 {p.balance}</div>
                          </div>
                        );
                      })}
                  </div>
                </div>
              ) : (
                <>
                  <h4 style={{ margin: "0 0 6px", fontSize: "0.95rem" }}>Host &amp; Players ({players.length + 1})</h4>
                  <div className="sidebar-players">
                    <div className="player-pill-compact" style={{
                      borderColor: isHost ? "#ff8f9f" : undefined,
                      borderWidth: isHost ? 3 : undefined,
                      background: "#c6f7e2",
                    }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <div style={{ fontSize: "0.72rem", opacity: 0.6 }}>👑</div>
                        <strong>{room?.host_username || "Host"}</strong>
                        {isHost && <span style={{ fontSize: "0.7rem" }}> (you)</span>}
                      </div>
                      <span style={{ fontSize: "0.75rem", color: "#065f46", fontWeight: "bold" }}>HOST</span>
                    </div>

                    {players.map(p => {
                      const isMe = p.player_id === user?.playerId;
                      const showBalance = isMe || isHost || phase === "lobby" || phase === "results" || isGameFinished;
                      return (
                        <div key={p.player_id} className="player-pill-compact" style={{
                          opacity: p.is_bankrupt ? 0.4 : 1,
                          borderColor: isMe ? "#ff8f9f" : undefined,
                          borderWidth: isMe ? 3 : undefined,
                        }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <div style={{ fontSize: "0.72rem", opacity: 0.6 }}>{p.avatar_seed}</div>
                            <strong>{p.username}</strong>
                            {isMe && <span style={{ fontSize: "0.7rem" }}> (you)</span>}
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <div>💰 {showBalance ? p.balance : "?"}</div>
                            {p.is_bankrupt && <div style={{ color: "#ff6b6b", fontSize: "0.75rem", fontWeight: "bold" }}>Bankrupt</div>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>

            <small style={{ opacity: 0.5 }}>{msg}</small>
          </div>
        </section>
      </main>

      {/* ── Username Input Modal ── */}
      {showUsernameModal && (
        <div style={{
          position: "fixed",
          inset: 0,
          zIndex: 1100,
          background: "rgba(30, 20, 50, 0.75)",
          backdropFilter: "blur(6px)",
          display: "grid",
          placeItems: "center",
          padding: 24
        }}>
          <form onSubmit={handleUsernameSubmit} className="card" style={{
            width: "100%",
            maxWidth: 400,
            display: "flex",
            flexDirection: "column",
            gap: 16,
            textAlign: "center"
          }}>
            <h2 style={{ fontFamily: "Itim, cursive", margin: 0, fontSize: "1.8rem" }}>
              Biệt danh của bạn 🎨
            </h2>
            <p style={{ margin: 0, opacity: 0.8, fontSize: "1.05rem" }}>
              Vui lòng nhập tên để mọi người biết bạn là ai khi tham gia phòng chơi!
            </p>
            <input
              type="text"
              className="input"
              placeholder="Tên của bạn..."
              required
              value={usernameInput}
              onChange={e => setUsernameInput(e.target.value)}
              autoFocus
              maxLength={15}
              style={{ textAlign: "center", fontSize: "1.2rem", fontWeight: "bold" }}
            />
            <button type="submit" className="btn" style={{ fontSize: "1.1rem" }}>
              Vào phòng chơi 🚀
            </button>
          </form>
        </div>
      )}

      {/* ── Fullscreen Final Leaderboard Overlay ── */}
      {isGameFinished && showFinalLeaderboard && (
        <div className="leaderboard-overlay">
          <div className="leaderboard-card">
            <h2 style={{ fontFamily: "Itim, cursive", fontSize: "2.4rem", margin: "0 0 4px", color: "var(--ink)", textAlign: "center" }}>
              🏆 BẢNG XẾP HẠNG 🏆
            </h2>
            <p style={{ margin: "0 0 16px", opacity: 0.7, fontSize: "1.15rem", textAlign: "center" }}>
              Kết quả chung cuộc của phòng <strong>{roomCode}</strong>
            </p>

            {/* Podium (Top 3) */}
            <div className="podium-container">
              {/* Rank 2 (Silver) - Left */}
              {sortedPlayers[1] ? (
                <div className="podium-item rank-2">
                  <span style={{ fontSize: "2.2rem", marginBottom: 4 }}>🥈</span>
                  <div className="podium-box silver">
                    <span className="podium-name">{sortedPlayers[1].username}</span>
                    <span className="podium-coins">💰 {sortedPlayers[1].balance}</span>
                  </div>
                </div>
              ) : (
                <div className="podium-item rank-2" style={{ opacity: 0.2 }}>
                  <span style={{ fontSize: "2.2rem", marginBottom: 4 }}>🥈</span>
                  <div className="podium-box silver" style={{ height: 105 }} />
                </div>
              )}

              {/* Rank 1 (Gold) - Center */}
              {sortedPlayers[0] ? (
                <div className="podium-item rank-1">
                  <span style={{ fontSize: "3rem", marginBottom: 4 }}>🥇</span>
                  <div className="podium-box gold">
                    <span className="podium-name">{sortedPlayers[0].username}</span>
                    <span className="podium-coins">💰 {sortedPlayers[0].balance}</span>
                  </div>
                  {confettiActive && <ConfettiExplosion />}
                </div>
              ) : (
                <div className="podium-item rank-1" style={{ opacity: 0.2 }}>
                  <span style={{ fontSize: "3rem", marginBottom: 4 }}>🥇</span>
                  <div className="podium-box gold" style={{ height: 130 }} />
                </div>
              )}

              {/* Rank 3 (Bronze) - Right */}
              {sortedPlayers[2] ? (
                <div className="podium-item rank-3">
                  <span style={{ fontSize: "2.2rem", marginBottom: 4 }}>🥉</span>
                  <div className="podium-box bronze">
                    <span className="podium-name">{sortedPlayers[2].username}</span>
                    <span className="podium-coins">💰 {sortedPlayers[2].balance}</span>
                  </div>
                </div>
              ) : (
                <div className="podium-item rank-3" style={{ opacity: 0.2 }}>
                  <span style={{ fontSize: "2.2rem", marginBottom: 4 }}>🥉</span>
                  <div className="podium-box bronze" style={{ height: 85 }} />
                </div>
              )}
            </div>

            {/* Rank 4+ List */}
            {restPlayers.length > 0 && (
              <div className="leaderboard-rest" style={{ width: "100%" }}>
                <hr style={{ border: "none", borderTop: "2px dashed var(--ink)", margin: "16px 0" }} />
                <div className="scrollable-list" style={{ maxHeight: "180px", overflowY: "auto", paddingRight: "6px" }}>
                  {restPlayers.map((p, idx) => {
                    const rank = idx + 4;
                    const isMe = p.player_id === user?.playerId;
                    return (
                      <div key={p.player_id} className={`rest-row ${isMe ? 'highlight' : ''}`}>
                        <span className="rest-rank">{rank}.</span>
                        <span className="rest-name">{p.username} {isMe && "⭐"}</span>
                        <span className="rest-coins">💰 {p.balance}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Highlight card for current user if rank is 4 or below */}
            {!isHost && userRankIndex >= 3 && me && (
              <div className="leaderboard-rest" style={{ width: "100%" }}>
                <div className="user-rank-footer-card">
                  <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }}>
                    <span style={{ fontSize: "1.4rem" }}>⭐</span>
                    <span>Bạn đứng hạng <strong>#{userRankIndex + 1}</strong> ({me.username})</span>
                    <span style={{ marginLeft: "auto", fontWeight: "bold", fontSize: "1.1rem" }}>💰 {me.balance} coins</span>
                  </div>
                </div>
              </div>
            )}

            {/* Controls */}
            <div style={{ display: "flex", gap: 12, marginTop: 24, width: "100%", justifyContent: "center" }}>
              {isHost ? (
                <button type="button" className="btn danger" style={{ flex: 1 }} onClick={endRoom}>
                  🏁 Kết thúc phòng
                </button>
              ) : (
                <button type="button" onClick={handleLeave} className="btn secondary" style={{ flex: 1, textAlign: "center" }}>
                  🚪 Rời phòng
                </button>
              )}
              <button
                type="button"
                className="btn secondary"
                style={{ flex: 1, background: "rgba(0,0,0,0.05)" }}
                onClick={() => setShowFinalLeaderboard(false)}
              >
                👁 Xem lại đáp án
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Floating button to reopen leaderboard when closed */}
      {!showFinalLeaderboard && isGameFinished && (
        <button
          type="button"
          className="btn"
          style={{
            position: "fixed",
            top: 12,
            right: 12,
            zIndex: 1001,
            boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
            background: "var(--mint)"
          }}
          onClick={() => setShowFinalLeaderboard(true)}
        >
          🏆 Xem BXH Chung Cuộc
        </button>
      )}
    </>
  );
}

