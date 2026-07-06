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

// ── Sky palette interpolation: câu 1 = bình minh, giữa = ngày, câu cuối = hoàng hôn ──
function lerp(a, b, t) { return a + (b - a) * t; }
function lerpColor(c1, c2, t) {
  return [0, 1, 2].map(i => Math.round(lerp(c1[i], c2[i], t)));
}
function rgb(c) { return `rgb(${c[0]}, ${c[1]}, ${c[2]})`; }

// keyframes: dawn(0) → day(0.5) → dusk(1). Mỗi stop có 3 dải màu trời (top/mid/bottom) + màu ánh sáng mặt trời.
const SKY_STOPS = [
  { top: [255, 183, 148], mid: [255, 214, 170], bot: [255, 225, 200], sun: [255, 179, 102] },  // 0.0 bình minh
  { top: [125, 196, 255], mid: [178, 224, 255], bot: [224, 244, 255], sun: [255, 236, 140] },  // 0.5 ngày
  { top: [90, 56, 122],   mid: [255, 130, 100], bot: [255, 190, 120], sun: [255, 110, 70] },   // 1.0 hoàng hôn
];
function skyAt(t) {
  t = Math.max(0, Math.min(1, t));
  const seg = t < 0.5 ? 0 : 1;
  const lt = t < 0.5 ? t / 0.5 : (t - 0.5) / 0.5;
  const a = SKY_STOPS[seg], b = SKY_STOPS[seg + 1];
  return {
    top: lerpColor(a.top, b.top, lt),
    mid: lerpColor(a.mid, b.mid, lt),
    bot: lerpColor(a.bot, b.bot, lt),
    sun: lerpColor(a.sun, b.sun, lt),
  };
}

function RunnerScene({ me, players = [], isHost = false, isLocalWin = false, roundResult, animateProgress, currentRoundIndex, phase, questionOpen, totalQ, remainingMs = 0, roundDuration = 20, children }) {
  const obstacleId = ((currentRoundIndex * 7 + 3) % 10) + 1;
  const avatarId = me?.avatar_seed && me.avatar_seed !== "P" && !isNaN(Number(me.avatar_seed)) ? me.avatar_seed : "1";
  const myName = me?.username || "Bạn";
  const myBalance = me?.balance ?? 0;

  // Kết quả round: đúng → nhảy qua + cộng tiền; sai → đâm + nhấp nháy + trừ tiền
  const isWin = phase === "won_waiting" ? isLocalWin : (roundResult?.resulting_is_win === true);
  const showResult = phase === "results" && animateProgress && roundResult;

  // Cảnh trôi khi đang chạy (chỉ đứng im khi đang làm bài vẽ)
  const isRunning = !(phase === "active" && questionOpen) && phase !== "lobby" && phase !== "bankrupt";

  // Obstacle: trôi từ phải vào, dừng cách nhân vật ~1 thân khi câu hỏi mở.
  const [obstaclePos, setObstaclePos] = useState(105);
  const [obstacleGone, setObstacleGone] = useState(false);
  const [activeAnim, setActiveAnim] = useState("");

  const prevRoundIndexRef = useRef(currentRoundIndex);
  const animRoundRef = useRef(-1);

  // Sync animation states seamlessly
  useEffect(() => {
    if (phase === "lobby") {
      setActiveAnim("");
      animRoundRef.current = -1;
    } else if (phase === "active") {
      animRoundRef.current = -1;
      if (questionOpen) {
        setActiveAnim("");
      } else {
        setActiveAnim("rs-run");
      }
    } else if (phase === "won_waiting") {
      if (animRoundRef.current !== currentRoundIndex) {
        animRoundRef.current = currentRoundIndex;
        // Trigger jump if correct, otherwise crash/flash!
        setActiveAnim(isLocalWin ? "rs-jump" : "rs-crash");
        const t = setTimeout(() => {
          setActiveAnim("rs-run");
        }, 1200);
        return () => clearTimeout(t);
      }
    } else if (phase === "submitting") {
      if (animRoundRef.current !== currentRoundIndex) {
        animRoundRef.current = currentRoundIndex;
        setActiveAnim(isLocalWin ? "rs-jump" : "rs-crash");
        const t = setTimeout(() => {
          setActiveAnim("rs-run");
        }, 1200);
        return () => clearTimeout(t);
      }
    } else if (phase === "results") {
      if (animRoundRef.current !== currentRoundIndex && roundResult) {
        animRoundRef.current = currentRoundIndex;
        setActiveAnim(roundResult.resulting_is_win ? "rs-jump" : "rs-crash");
        const t = setTimeout(() => {
          setActiveAnim("rs-run");
        }, 1200);
        return () => clearTimeout(t);
      } else if (animRoundRef.current === currentRoundIndex) {
        if (activeAnim === "rs-jump" || activeAnim === "rs-crash") {
          const t = setTimeout(() => {
            setActiveAnim("rs-run");
          }, 1000);
          return () => clearTimeout(t);
        } else {
          setActiveAnim("rs-run");
        }
      }
    }
  }, [phase, questionOpen, roundResult, currentRoundIndex, isLocalWin]);

  useEffect(() => {
    if (phase === "active") {
      // Khi sang round mới mới bắt đầu chuẩn hoá lại vị trí từ 105
      if (prevRoundIndexRef.current !== currentRoundIndex) {
        setObstaclePos(105);
        setObstacleGone(false);
        prevRoundIndexRef.current = currentRoundIndex;
      }
      if (questionOpen) {
        setObstaclePos(34);
      } else {
        const t = setTimeout(() => setObstaclePos(34), 60);
        return () => clearTimeout(t);
      }
    } else if (phase === "won_waiting") {
      // Trả lời đúng cái là di chuyển/vượt chướng ngại vật ngay lập tức, trả lời sai bị đâm
      if (isLocalWin) {
        setObstacleGone(false);
        setObstaclePos(-25);
      } else {
        setObstaclePos(20);
        const t = setTimeout(() => setObstacleGone(true), 350);
        return () => clearTimeout(t);
      }
    } else if (phase === "submitting") {
      if (isLocalWin) {
        setObstacleGone(false);
        setObstaclePos(-25);
      } else {
        setObstaclePos(20);
        const t = setTimeout(() => setObstacleGone(true), 350);
        return () => clearTimeout(t);
      }
    } else if (phase === "results" && roundResult) {
      if (roundResult.resulting_is_win) {
        setObstacleGone(false);
        setObstaclePos(-25);
      } else {
        setObstaclePos(20);
        const t = setTimeout(() => setObstacleGone(true), 350);
        return () => clearTimeout(t);
      }
    } else if (phase === "lobby") {
      setObstaclePos(105);
      setObstacleGone(false);
      prevRoundIndexRef.current = currentRoundIndex;
    }
  }, [phase, questionOpen, roundResult, currentRoundIndex, isLocalWin]);

  // Sky và Mặt trời di chuyển mượt mà liên tục theo thời lượng ước tính kết thúc game
  let timeProgress = 0;
  if (phase === "active" && questionOpen && remainingMs > 0) {
    const elapsed = Math.max(0, roundDuration - (remainingMs / 1000));
    timeProgress = elapsed / roundDuration;
  } else if (phase === "won_waiting" || phase === "submitting" || phase === "results") {
    timeProgress = 1;
  }
  const smoothRoundIndex = currentRoundIndex + timeProgress;
  const progress = totalQ > 1 ? smoothRoundIndex / (totalQ - 1) : 0;

  const sky = skyAt(progress);
  const skyBackground = `linear-gradient(to bottom, ${rgb(sky.top)} 0%, ${rgb(sky.mid)} 55%, ${rgb(sky.bot)} 100%)`;
  // Mặt trời: mọc thấp bên trái ở câu đầu → lên cao giữa trời ở giữa → lặn thấp bên phái ở câu cuối
  const sunLeft = lerp(12, 84, progress);
  const sunTop = 70 - Math.sin(progress * Math.PI) * 48; // parabol: thấp-cao-thấp (theo %)

  const avatarAnim = activeAnim;

  // Dynamic obstacle transition speed
  const obstacleTransition = (obstaclePos === 105)
    ? "none"
    : (phase === "results" || phase === "won_waiting" || phase === "submitting")
    ? (phase === "won_waiting" || isLocalWin || roundResult?.resulting_is_win === true ? "left 1.2s linear" : "left 0.25s cubic-bezier(0.25, 1, 0.5, 1)")
    : "left 2.4s linear";

  if (isHost) {
    return (
      <div style={{
        position: "absolute",
        inset: 0,
        zIndex: 100,
        background: skyBackground,
        borderRadius: 18,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "20px",
        boxSizing: "border-box",
        color: "#fff",
        fontFamily: "Fredoka, sans-serif",
        transition: "background 1.5s ease-in-out"
      }}>
        <style dangerouslySetInnerHTML={{__html: `
          @keyframes rs-scroll-loop { from { transform: translateX(0); } to { transform: translateX(-50%); } }
          .rs-clouds-run { animation: rs-scroll-loop 40s linear infinite; }
          @keyframes rs-run {
            0%,100% { transform: translateY(0) rotate(-4deg); }
            50%     { transform: translateY(-4px) rotate(4deg); }
          }
          .rs-run-avatar { animation: rs-run 0.32s ease-in-out infinite; }
          @keyframes rs-jump {
            0%, 100% { transform: translateY(0) scale(1); }
            50% { transform: translateY(-20px) scale(1.1) rotate(-5deg); }
          }
          .rs-jump-avatar { animation: rs-jump 0.8s ease-in-out infinite; }
        `}} />

        {/* ── SUN ── */}
        <div
          className="rs-sun"
          style={{
            position: "absolute",
            left: `${sunLeft}%`,
            top: `${sunTop}%`,
            width: 66,
            height: 66,
            marginLeft: -33,
            borderRadius: "50%",
            background: `radial-gradient(circle at 38% 34%, #fffbe6, ${rgb(sky.sun)} 68%)`,
            "--sun-halo": `${rgb(sky.sun)}`,
            zIndex: 1,
            pointerEvents: "none",
            transition: "left 1.6s ease-in-out, top 1.6s ease-in-out, background 1.6s ease-in-out",
          }}
        />

        {/* ── CLOUDS ── */}
        <div style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "40%", overflow: "hidden", pointerEvents: "none", zIndex: 2 }}>
          <div className="rs-clouds-run" style={{ position: "absolute", top: 0, left: 0, width: "200%", height: "100%" }}>
            {[0, 1].map(copy => (
              <div key={copy} style={{ position: "absolute", top: 0, left: `${copy * 50}%`, width: "50%", height: "100%" }}>
                {[
                  { l: 6, t: 14, w: 96, h: 30 },
                  { l: 24, t: 30, w: 128, h: 38 },
                  { l: 62, t: 24, w: 112, h: 34 },
                ].map((c, i) => (
                  <div key={i} style={{
                    position: "absolute", left: `${c.l}%`, top: `${c.t}%`,
                    width: c.w, height: c.h,
                    background: "rgba(255,255,255,0.82)",
                    borderRadius: 100,
                  }} />
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* Header Title for Host */}
        <div style={{ zIndex: 10, display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "2px solid rgba(255,255,255,0.25)", paddingBottom: 6 }}>
          <span style={{ fontSize: "1.2rem", fontWeight: "bold", fontFamily: "Itim, cursive", color: "#ffd7ba", textShadow: "0 2px 4px rgba(0,0,0,0.3)" }}>
            👑 ĐƯỜNG ĐUA KỲ THÚ (HOST SPECTATOR ARENA)
          </span>
          <span style={{ fontSize: "0.9rem", background: "rgba(0,0,0,0.3)", padding: "2px 8px", borderRadius: 8 }}>
            Câu {currentRoundIndex + 1} / {totalQ}
          </span>
        </div>

        {/* Lanes Container */}
        <div style={{
          zIndex: 10,
          flex: 1,
          display: "flex",
          flexDirection: "column",
          gap: 8,
          justifyContent: "center",
          margin: "12px 0",
          background: "rgba(15, 23, 42, 0.4)",
          border: "2px solid rgba(255, 255, 255, 0.15)",
          borderRadius: 16,
          padding: 12,
          overflowY: "auto",
        }}>
          {players.length === 0 ? (
            <div style={{ textAlign: "center", opacity: 0.6, fontSize: "1rem", padding: 20 }}>
              Đang đợi người chơi tham gia...
            </div>
          ) : (
            players.map((p, idx) => {
              const avatarSeed = p.avatar_seed && p.avatar_seed !== "P" && !isNaN(Number(p.avatar_seed)) ? p.avatar_seed : "1";
              const hasSubmitted = p.last_submitted_round === currentRoundIndex;
              const isBankrupt = p.is_bankrupt || p.balance <= 0;
              
              let statusLabel = "📝 Đang làm bài...";
              let statusColor = "#ffd7ba";
              let animClass = "rs-run-avatar";
              
              if (isBankrupt) {
                statusLabel = "💀 Bị loại";
                statusColor = "#ef4444";
                animClass = "";
              } else if (hasSubmitted) {
                statusLabel = "✅ Đã nộp bài";
                statusColor = "#4ade80";
                animClass = "rs-jump-avatar";
              }
              
              return (
                <div key={p.player_id} style={{
                  display: "flex",
                  alignItems: "center",
                  background: "rgba(255, 255, 255, 0.08)",
                  borderRadius: 10,
                  padding: "6px 12px",
                  borderLeft: `5px solid ${statusColor}`,
                  boxSizing: "border-box",
                  position: "relative"
                }}>
                  <div style={{ width: 140, display: "flex", flexDirection: "column", gap: 2 }}>
                    <span style={{ fontWeight: "bold", fontSize: "0.95rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {p.username}
                    </span>
                    <span style={{ fontSize: "0.82rem", opacity: 0.8, color: "#cbd5e1" }}>
                      💰 {p.balance} coins
                    </span>
                  </div>

                  <div style={{
                    flex: 1,
                    height: 38,
                    background: "rgba(0,0,0,0.2)",
                    borderRadius: 8,
                    border: "1px dashed rgba(255,255,255,0.2)",
                    margin: "0 12px",
                    position: "relative",
                    display: "flex",
                    alignItems: "center",
                    padding: "0 10px"
                  }}>
                    <div
                      className={animClass}
                      style={{
                        position: "absolute",
                        left: isBankrupt ? "5%" : hasSubmitted ? "85%" : "40%",
                        transition: "left 1s ease-in-out",
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        opacity: isBankrupt ? 0.4 : 1,
                      }}
                    >
                      <img
                        src={`/characters/${avatarSeed}.png`}
                        alt=""
                        style={{ height: 28, width: 28, objectFit: "contain" }}
                      />
                    </div>
                  </div>

                  <div style={{
                    fontSize: "0.85rem",
                    fontWeight: "bold",
                    color: statusColor,
                    width: 100,
                    textAlign: "right"
                  }}>
                    {statusLabel}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {children}
      </div>
    );
  }

  return (
    <div style={{
      position: "absolute",
      inset: 0,
      zIndex: 100,
      background: skyBackground,
      borderRadius: 18,
      overflow: "hidden",
      display: "flex",
      flexDirection: "column",
      justifyContent: "space-between",
      padding: "20px",
      boxSizing: "border-box",
      color: "#fff",
      fontFamily: "Fredoka, sans-serif",
      transition: "background 1.5s ease-in-out"
    }}>
      <style dangerouslySetInnerHTML={{__html: `
        @keyframes rs-scroll-loop { from { transform: translateX(0); } to { transform: translateX(-50%); } }
        .rs-ground-run { animation: rs-scroll-loop 3s linear infinite; }
        .rs-clouds-run { animation: rs-scroll-loop 40s linear infinite; }
        .rs-hills-run  { animation: rs-scroll-loop 14s linear infinite; }
        .rs-paused     { animation-play-state: paused !important; }
        @keyframes rs-run {
          0%,100% { transform: translateX(-50%) translateY(0)    rotate(-4deg); }
          50%     { transform: translateX(-50%) translateY(-6px) rotate(4deg); }
        }
        .rs-run { animation: rs-run 0.32s ease-in-out infinite; }
        @keyframes rs-jump {
          0%   { transform: translateX(-50%) translateY(0) scale(1, 1); }
          10%  { transform: translateX(-50%) translateY(4px) scale(1.15, 0.85); }
          35%  { transform: translateX(-50%) translateY(-110px) scale(0.85, 1.15) rotate(-12deg); }
          60%  { transform: translateX(-50%) translateY(-110px) scale(0.9, 1.1) rotate(-8deg); }
          85%  { transform: translateX(-50%) translateY(-10px) scale(1.05, 0.95); }
          90%  { transform: translateX(-50%) translateY(0) scale(1.1, 0.9); }
          100% { transform: translateX(-50%) translateY(0) scale(1, 1); }
        }
        .rs-jump { animation: rs-jump 1.2s cubic-bezier(0.25, 1, 0.5, 1) 1 forwards; }
        @keyframes rs-crash {
          0%, 100% { transform: translateX(-50%) translateY(0) rotate(0deg) scale(1); opacity: 1; filter: none; }
          10%, 30%, 50%, 70%, 90% { transform: translateX(-52%) translateY(-2px) rotate(-3deg) scale(1); opacity: 0.15; filter: drop-shadow(0 0 8px #ef4444) sepia(1) saturate(5) hue-rotate(-50deg); }
          20%, 40%, 60%, 80% { transform: translateX(-48%) translateY(2px) rotate(3deg) scale(1.05); opacity: 1; filter: drop-shadow(0 0 12px #ef4444) sepia(1) saturate(8) hue-rotate(-50deg); }
        }
        .rs-crash { animation: rs-crash 1.2s ease-in-out 1 forwards; }
        @keyframes rs-obstacle-crash {
          0%   { transform: translateX(-50%) scale(1); }
          15%  { transform: translateX(-50%) translateY(-10px) rotate(20deg) scale(0.9); }
          40%  { transform: translateX(-50%) translateY(30px) rotate(45deg) scale(0.6); opacity: 0; }
          100% { transform: translateX(-50%) translateY(30px) opacity: 0; }
        }
        .rs-obstacle-crash { animation: rs-obstacle-crash 1.2s ease-out 1 forwards; }
        @keyframes rs-sun-glow {
          0%,100% { box-shadow: 0 0 24px 6px var(--sun-halo), 0 0 60px 14px var(--sun-halo); }
          50%     { box-shadow: 0 0 34px 10px var(--sun-halo), 0 0 80px 20px var(--sun-halo); }
        }
        .rs-sun { animation: rs-sun-glow 4s ease-in-out infinite; }
      `}} />

      {/* ── SUN: mọc câu 1 (thấp trái) → đỉnh trời giữa game → lặn câu cuối (thấp phải) ── */}
      <div
        className="rs-sun"
        style={{
          position: "absolute",
          left: `${sunLeft}%`,
          top: `${sunTop}%`,
          width: 66,
          height: 66,
          marginLeft: -33,
          borderRadius: "50%",
          background: `radial-gradient(circle at 38% 34%, #fffbe6, ${rgb(sky.sun)} 68%)`,
          "--sun-halo": `${rgb(sky.sun)}`,
          zIndex: 1,
          pointerEvents: "none",
          transition: "left 1.6s ease-in-out, top 1.6s ease-in-out, background 1.6s ease-in-out",
        }}
      />

      {/* ── CLOUDS: Luôn di chuyển trôi chậm ── */}
      <div style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "58%", overflow: "hidden", pointerEvents: "none", zIndex: 2 }}>
        <div className="rs-clouds-run" style={{ position: "absolute", top: 0, left: 0, width: "200%", height: "100%" }}>
          {[0, 1].map(copy => (
            <div key={copy} style={{ position: "absolute", top: 0, left: `${copy * 50}%`, width: "50%", height: "100%" }}>
              {[
                { l: 6, t: 14, w: 96, h: 30 },
                { l: 24, t: 30, w: 128, h: 38 },
                { l: 40, t: 8, w: 74, h: 24 },
                { l: 62, t: 24, w: 112, h: 34 },
                { l: 82, t: 12, w: 88, h: 28 },
              ].map((c, i) => (
                <div key={i} style={{
                  position: "absolute", left: `${c.l}%`, top: `${c.t}%`,
                  width: c.w, height: c.h,
                  background: "rgba(255,255,255,0.82)",
                  borderRadius: 100,
                  boxShadow: "0 6px 14px rgba(0,0,0,0.06)",
                  filter: "blur(0.5px)",
                }} />
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* ── ROLLING HILLS (parallax chậm, màu ấm hoà theo trời) ── */}
      <div style={{ position: "absolute", left: 0, bottom: 64, width: "100%", height: 90, overflow: "hidden", pointerEvents: "none", zIndex: 3 }}>
        <div className={isRunning ? "rs-hills-run" : "rs-hills-run rs-paused"} style={{ position: "absolute", bottom: 0, left: 0, width: "200%", height: "100%", display: "flex" }}>
          {[0, 1].map(copy => (
            <svg key={copy} viewBox="0 0 1000 120" preserveAspectRatio="none" style={{ width: "50%", height: "100%" }}>
              <path d="M0,120 Q120,55 250,80 T520,70 T780,85 T1000,68 L1000,120 Z" fill={rgb(sky.mid)} opacity="0.55" />
              <path d="M0,120 Q160,80 320,100 T640,92 T1000,100 L1000,120 Z" fill={rgb(sky.bot)} opacity="0.75" />
            </svg>
          ))}
        </div>
      </div>

      {/* ── CHILDREN (câu hỏi / result card nổi lên trên) ── */}
      {children}

      {/* ── GROUND STRIP + texture trôi + nhân vật + chướng ngại vật ── */}
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 74, zIndex: 5 }}>
        <div style={{
          position: "absolute", left: 0, right: 0, bottom: 0, height: 44,
          background: `linear-gradient(to bottom, ${rgb(sky.bot)}, rgba(90,70,45,0.9))`,
          borderTop: "3px solid rgba(60,45,30,0.65)",
        }} />
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 44, overflow: "hidden" }}>
          <div className={isRunning ? "rs-ground-run" : "rs-ground-run rs-paused"} style={{ position: "absolute", bottom: 8, left: 0, width: "200%", height: 18, display: "flex" }}>
            {[0, 1].map(copy => (
              <div key={copy} style={{ width: "50%", height: "100%", position: "relative" }}>
                {/* Đám cỏ dễ thương trên mặt đất */}
                {[5, 15, 28, 38, 50, 60, 72, 85, 95].map((pos, idx) => (
                  <div key={`grass-${idx}`} style={{
                    position: "absolute",
                    left: `${pos}%`,
                    top: -6,
                    display: "flex",
                    gap: 1,
                    alignItems: "flex-end",
                  }}>
                    <div style={{ width: 3, height: 8, background: "#4ade80", borderRadius: "2px 2px 0 0", transform: "rotate(-10deg)", transformOrigin: "bottom center" }} />
                    <div style={{ width: 3, height: 12, background: "#22c55e", borderRadius: "2px 2px 0 0", transform: "rotate(0deg)", transformOrigin: "bottom center" }} />
                    <div style={{ width: 3, height: 6, background: "#4ade80", borderRadius: "2px 2px 0 0", transform: "rotate(15deg)", transformOrigin: "bottom center" }} />
                  </div>
                ))}
                
                {/* Kết cấu đất trôi */}
                {[8, 24, 45, 63, 82].map((l, i) => (
                  <div key={i} style={{ position: "absolute", left: `${l}%`, bottom: 0, width: 26, height: 4, borderRadius: 3, background: "rgba(255,255,255,0.35)" }} />
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* CHƯỚNG NGẠI VẬT — trôi từ phải vào, dừng trước nhân vật khi câu hỏi mở */}
        {!obstacleGone && (
          <div
            className={activeAnim === "rs-crash" ? "rs-obstacle-crash" : ""}
            style={{
              position: "absolute",
              left: `${obstaclePos}%`,
              bottom: 34,
              transform: "translateX(-50%)",
              transition: obstacleTransition,
              zIndex: 7,
            }}
          >
            <img
              src={`/obstacles/${obstacleId}.png`}
              alt=""
              style={{ height: 62, objectFit: "contain", filter: "drop-shadow(0 3px 5px rgba(0,0,0,0.25))" }}
            />
          </div>
        )}

        {/* NHÂN VẬT DUY NHẤT (người chơi) — chân đặt trên mặt đất */}
        <div
          className={avatarAnim}
          style={{
            position: "absolute",
            left: "20%",
            bottom: 34,
            transformOrigin: "center bottom",
            zIndex: 9,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
          }}
        >
          <img
            src={`/characters/${avatarId}.png`}
            alt={myName}
            style={{ width: 92, height: 92, objectFit: "contain", filter: "drop-shadow(0 4px 6px rgba(0,0,0,0.3))" }}
          />
          <span style={{
            fontSize: "0.72rem", fontWeight: 700,
            background: "rgba(47,42,60,0.85)", color: "#fff",
            padding: "2px 8px", borderRadius: 6, whiteSpace: "nowrap", marginTop: 2,
            fontFamily: "Itim, cursive",
          }}>
            {myName} ({myBalance})
          </span>
        </div>
      </div>
    </div>
  );
}

const mockPrecisionQ = {
  id: "mock_precision",
  q_text: "Hãy click vào hồng tâm ở giữa bông hoa!",
  elements: [
    { id: "flower", type: "IMAGE_DRAWING", x: 200, y: 100, w: 400, h: 300, is_correct: false },
    { id: "target1", type: "PRECISION_TARGET", x: 380, y: 230, w: 40, h: 40, rx: 0.4, ry: 0.5, is_correct: true }
  ]
};

const mockGaugeQ = {
  id: "mock_gauge",
  q_text: "Điều chỉnh thanh kéo tới vị trí 70%!",
  elements: [
    { id: "gauge", type: "GAUGE_BLOCK", targetVal: 70, minVal: 0, maxVal: 100 }
  ]
};

const mockBlanksQ = {
  id: "mock_blanks",
  q_text: "Điền từ còn thiếu vào ô trống dưới đây:",
  elements: [
    { id: "text1", type: "TEXT_BLOCK", text: "Thú cưng cute nhất quả đất là con ____" },
    { id: "blank1", type: "BLANK_BLOCK", correctText: "mèo,chó,gấu", label: "Đáp án" }
  ]
};

const SANDBOX_STATES = [
  {
    id: "lobby",
    label: "Lobby",
    phase: "lobby",
    revealQuestion: false,
    isGameFinished: false,
    showOverlay: true
  },
  {
    id: "active_run",
    label: "Runner Intro",
    phase: "active",
    revealQuestion: false,
    isGameFinished: false,
    showOverlay: true
  },
  {
    id: "q_precision",
    label: "Q: Precision Target",
    phase: "active",
    revealQuestion: true,
    isGameFinished: false,
    showOverlay: false,
    question: mockPrecisionQ
  },
  {
    id: "q_gauge",
    label: "Q: Gauge Slider",
    phase: "active",
    revealQuestion: true,
    isGameFinished: false,
    showOverlay: false,
    question: mockGaugeQ
  },
  {
    id: "q_blanks",
    label: "Q: Fill Blanks",
    phase: "active",
    revealQuestion: true,
    isGameFinished: false,
    showOverlay: false,
    question: mockBlanksQ
  },
  {
    id: "submitted",
    label: "Submitted",
    phase: "won_waiting",
    revealQuestion: true,
    isGameFinished: false,
    showOverlay: true
  },
  {
    id: "res_win",
    label: "Result: Win",
    phase: "results",
    revealQuestion: true,
    isGameFinished: false,
    showOverlay: true,
    roundResult: {
      resulting_is_win: true,
      delta: 15,
      resulting_balance: 25,
      rng_factor: 1.5
    }
  },
  {
    id: "res_loss",
    label: "Result: Loss",
    phase: "results",
    revealQuestion: true,
    isGameFinished: false,
    showOverlay: true,
    roundResult: {
      resulting_is_win: false,
      delta: -8,
      resulting_balance: 4,
      rng_factor: 0
    }
  },
  {
    id: "bankrupt",
    label: "Bankrupt",
    phase: "bankrupt",
    revealQuestion: true,
    isGameFinished: false,
    showOverlay: true
  },
  {
    id: "podium",
    label: "Final Podium",
    phase: "results",
    revealQuestion: true,
    isGameFinished: true,
    showOverlay: true,
    roundResult: {
      resulting_is_win: true,
      delta: 0,
      resulting_balance: 10
    }
  }
];

export default function RoomPage({ params }) {
  const roomCode = String(params.code || "").toUpperCase();
  const router = useRouter();
  const [user, setUser] = useState(null);
  const hostSecret = typeof window !== "undefined" ? (getRoomState(roomCode)?.hostSecret ?? null) : null;

  const [bootstrap,  setBootstrap]  = useState(null);
  let   [phase,      setPhase]      = useState("lobby");
  const [bet,        setBet]        = useState(1);
  const [remainingMs,setRemainingMs]= useState(0);
  let   [roundResult,setRoundResult]= useState(null);
  const [msg,        setMsg]        = useState("Joining room...");
  let   [showOverlay,setShowOverlay]= useState(true);
  const [showAnswersCanvas, setShowAnswersCanvas] = useState(false);
  const [hasSubmittedLocal, setHasSubmittedLocal] = useState(false);
  const [showUsernameModal, setShowUsernameModal] = useState(false);
  const [usernameInput, setUsernameInput] = useState("");
  const [showFinalLeaderboard, setShowFinalLeaderboard] = useState(true);
  const [confettiActive, setConfettiActive] = useState(false);
  const [hasConfirmedName, setHasConfirmedName] = useState(false);
  const [reviewQuestionIndex, setReviewQuestionIndex] = useState(null);
  const [prevBalances, setPrevBalances] = useState({});
  const [animateProgress, setAnimateProgress] = useState(false);
  const [selectedCharacter, setSelectedCharacter] = useState(1);
  let   [revealQuestion, setRevealQuestion] = useState(false);

  useEffect(() => {
    if (phase === "active") {
      setRevealQuestion(false);
      localWinRef.current = null;
      submittedRef.current = false;
      lastClickRef.current = null;
      lastGaugeRef.current = null;
      // Obstacle trôi vào (~2.2s) → vừa tới gần nhân vật là mở câu hỏi ngay, không chờ
      const timer = setTimeout(() => {
        setRevealQuestion(true);
      }, 2200);
      return () => clearTimeout(timer);
    } else {
      setRevealQuestion(false);
    }
  }, [phase]);

  useEffect(() => {
    if (phase === "active" && bootstrap?.players) {
      const balances = {};
      bootstrap.players.forEach(p => {
        balances[p.player_id] = p.balance;
      });
      setPrevBalances(balances);
    }
  }, [phase, bootstrap?.players]);

  useEffect(() => {
    if (phase === "results") {
      setAnimateProgress(false);
      const t = setTimeout(() => {
        setAnimateProgress(true);
      }, 1500);
      return () => clearTimeout(t);
    } else {
      setAnimateProgress(false);
    }
  }, [phase]);

  const [isAdminMode, setIsAdminMode] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("cutequiz:admin_mode") === "true";
    }
    return false;
  });
  const [sandboxState, setSandboxState] = useState(null);
  const keyBufferRef = useRef("");

  // Derived render values (from state)
  const room      = bootstrap?.room;
  let   players   = bootstrap?.players ?? [];
  const me        = players.find(p => p.player_id === user?.playerId) ?? null;
  // Host detection: instant via localStorage hostSecret (no DB wait) + confirmed via DB
  const hasHostSecret = !!(hostSecret && hostSecret !== "");
  const isHostByDb = !!(room && user && room.host_player_id === user.playerId);
  const isHost    = hasHostSecret || isHostByDb;
  const totalQ    = room?.quiz_payload?.questions?.length ?? 0;
  const activeQuestionIndex = reviewQuestionIndex !== null ? reviewQuestionIndex : (room?.current_round_index ?? 0);
  let   question  = room?.quiz_payload?.questions?.[activeQuestionIndex] ?? null;
  const myBalance = me?.balance ?? 10;
  const isBankrupt= me?.is_bankrupt ?? false;
  let   isGameFinished = room && room.current_round_index + 1 >= totalQ && phase === "results";

  // Sandbox state overrides
  if (isAdminMode && sandboxState) {
    if (sandboxState.phase !== undefined) phase = sandboxState.phase;
    if (sandboxState.revealQuestion !== undefined) revealQuestion = sandboxState.revealQuestion;
    if (sandboxState.roundResult !== undefined) roundResult = sandboxState.roundResult;
    if (sandboxState.showOverlay !== undefined) showOverlay = sandboxState.showOverlay;
    if (sandboxState.isGameFinished !== undefined) isGameFinished = sandboxState.isGameFinished;
    if (sandboxState.players !== undefined) players = sandboxState.players;
    if (sandboxState.question !== undefined) question = sandboxState.question;
  }

  const sortedPlayers = [...players].sort((a, b) => b.balance - a.balance);
  const restPlayers = sortedPlayers.slice(3);
  const userRankIndex = sortedPlayers.findIndex(p => p.player_id === user?.playerId);

  useEffect(() => {
    if (!isAdminMode) return;

    function handleArrowNav(e) {
      if (document.activeElement && (
        document.activeElement.tagName === "INPUT" ||
        document.activeElement.tagName === "TEXTAREA" ||
        document.activeElement.isContentEditable
      )) {
        return;
      }
      if (e.key === "ArrowRight") {
        setSandboxState(current => {
          const currentIndex = current ? SANDBOX_STATES.findIndex(s => s.id === current.id) : -1;
          const nextIndex = (currentIndex + 1) % SANDBOX_STATES.length;
          return SANDBOX_STATES[nextIndex];
        });
      } else if (e.key === "ArrowLeft") {
        setSandboxState(current => {
          const currentIndex = current ? SANDBOX_STATES.findIndex(s => s.id === current.id) : 0;
          const prevIndex = (currentIndex - 1 + SANDBOX_STATES.length) % SANDBOX_STATES.length;
          return SANDBOX_STATES[prevIndex];
        });
      }
    }

    window.addEventListener("keydown", handleArrowNav);
    return () => window.removeEventListener("keydown", handleArrowNav);
  }, [isAdminMode]);

  useEffect(() => {
    // Expose window.toandz() to console
    window.toandz = () => {
      setIsAdminMode(prev => {
        const next = !prev;
        localStorage.setItem("cutequiz:admin_mode", next ? "true" : "false");
        console.log(`[SYSTEM] Admin Mode (Slideshow) ${next ? "ENABLED" : "DISABLED"}`);
        alert(`[SYSTEM] Admin Mode (Slideshow) ${next ? "ENABLED" : "DISABLED"}`);
        return next;
      });
    };

    function handleKeyDown(e) {
      if (["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(e.key)) {
        return;
      }
      const newBuffer = (keyBufferRef.current + e.key).slice(-15);
      keyBufferRef.current = newBuffer;
      
      if (newBuffer.includes("toandz")) {
        window.toandz();
        keyBufferRef.current = "";
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      delete window.toandz;
    };
  }, []);

  useEffect(() => {
    if (!isAdminMode) return;

    let timer;

    if (phase === "lobby") {
      if (isHost) {
        timer = setTimeout(() => {
          console.log("[ADMIN] Auto starting quiz...");
          hostStartQuiz();
        }, 3000);
      }
    } else if (phase === "active") {
      if (revealQuestion) {
        timer = setTimeout(() => {
          console.log("[ADMIN] Auto solving question...");
          
          const correctZones = question?.elements?.filter(el =>
            (el.type === "PRECISION_TARGET" || el.type === "FREEFORM_ZONE") && el.role !== "DECOY"
          ) ?? [];
          const clicks = correctZones.map(el => ({ rx: el.rx || 0.5, ry: el.ry || 0.5, isLocalHit: true }));
          
          const gaugeBlock = question?.elements?.find(el => el.type === "GAUGE_BLOCK");
          if (gaugeBlock) {
            lastGaugeRef.current = gaugeBlock.targetVal ?? 50;
          }
          
          const blankBlocks = question?.elements?.filter(el => el.type === "BLANK_BLOCK") ?? [];
          const blanks = {};
          blankBlocks.forEach(block => {
            const val = (block.correctText ?? "").split(",")[0] || "correct";
            blanks[block.id] = val;
          });
          
          setPlayerClicks(clicks);
          setBlankAnswers(blanks);

          if (!isHost) {
            const finalWin = true;
            lastClickRef.current = clicks[0] || { rx: 0.5, ry: 0.5 };
            localWinRef.current = finalWin;
            syncPhase("won_waiting");
            
            const currentMe = bootstrap?.players?.find(p => p.player_id === user?.playerId);
            if (currentMe && room) {
              updatePlayerBalance(user.playerId, roomCode, currentMe.balance, currentMe.is_bankrupt, room.current_round_index).then();
            }
          } else {
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
        }, 4000);
      }
    } else if (phase === "results" && isHost) {
      timer = setTimeout(() => {
        if (room && room.current_round_index + 1 >= totalQ) {
          console.log("[ADMIN] Auto ending room...");
          endRoom();
        } else {
          console.log("[ADMIN] Auto moving to next question...");
          hostStartQuiz();
        }
      }, 6000);
    }

    return () => clearTimeout(timer);
  }, [isAdminMode, phase, revealQuestion, isHost, question, bootstrap, room, roomCode, totalQ]);

  // Refs keep values fresh inside setInterval callbacks (avoid stale closures)
  const bootstrapRef   = useRef(null);
  const phaseRef       = useRef("lobby");
  const betRef         = useRef(1);
  const localWinRef    = useRef(null);
  const startMsRef     = useRef(null);
  const submittedRef   = useRef(false);
  const didFireSubmitRef = useRef(false);
  const timerRef       = useRef(null);
  const prevDeadlineRef= useRef(null);
  const prevRoundIdxRef = useRef(null);
  const joinedRef      = useRef(false);
  const userRef        = useRef(null);
  const isHostRef      = useRef(!!(typeof window !== "undefined" && getRoomState(String(params.code || "").toUpperCase())?.hostSecret));
  const autoTimerRef   = useRef(null);
  const playerTokenRef = useRef(null);   // HMAC token from join — required by /submit-round
  const lastClickRef   = useRef(null);   // {rx, ry} of player's last canvas click this round
  const lastGaugeRef   = useRef(null);   // gauge value at click time (or null)
  const [autoSec, setAutoSec] = useState(0);
  const [playerClicks, setPlayerClicks] = useState([]);
  const [blankAnswers, setBlankAnswers] = useState({});

  function syncPhase(p) { setPhase(p); phaseRef.current = p; }
  function syncBet(v)   { setBet(v);   betRef.current   = v; }



  async function refreshBootstrap(silent = false, retries = 2) {
    if (roomCode === "TEST" || roomCode === "ADMIN") {
      const mockData = {
        room: {
          room_code: roomCode,
          current_round_index: 0,
          phase: "lobby",
          quiz_payload: {
            questions: [mockPrecisionQ, mockGaugeQ, mockBlanksQ]
          }
        },
        players: [
          { player_id: "p1", username: "Đậu Đậu 🐹", balance: 20, character_id: 1 },
          { player_id: "p2", username: "Gấu Bự 🐻", balance: 15, character_id: 2 },
          { player_id: "p3", username: "Mèo Mun 🐱", balance: 8, character_id: 3 },
          { player_id: "p4", username: "Cún Con 🐶", balance: 12, character_id: 4 }
        ]
      };
      bootstrapRef.current = mockData;
      setBootstrap(mockData);
      setIsAdminMode(true);
      return mockData;
    }
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const data = await getBootstrap(roomCode);
        bootstrapRef.current = data;
        setBootstrap(data);
        return data;
      } catch (err) {
        if (attempt < retries) {
          // Wait briefly and retry (handles cold-start timeouts)
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        if (!silent) setMsg(`Sync error: ${err.message}`);
        return null;
      }
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

  // ── Debug State Logging ───────────────────────────────────────────────────────
  useEffect(() => {
    console.log("[DEBUG] State Update:", {
      phase,
      roomExists: !!room,
      roomCode,
      isHost,
      hasHostSecret,
      isHostByDb,
      userExists: !!user,
      playerId: user?.playerId,
      playersCount: players.length,
      roundDeadlineAt: room?.round_deadline_at,
    });
  }, [phase, room, roomCode, isHost, hasHostSecret, isHostByDb, user, players]);

  // ── Initial bootstrap fetch ─────────────────────────────────────────────────────────
  useEffect(() => {
    refreshBootstrap(true, 3);
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
    const avatarSeed = String(selectedCharacter);
    const updatedUser = { ...user, username: trimmed, avatarSeed };
    saveUser(updatedUser);
    setUser(updatedUser);
    userRef.current = updatedUser;
    setHasConfirmedName(true);
    setShowUsernameModal(false);
  }

  useEffect(() => {
    if (!user) return;

    // Host is known immediately via localStorage hostSecret — skip join flow
    if (hasHostSecret) {
      joinedRef.current = true;
      setMsg("Spectating as Host 👑");
      return;
    }

    if (!bootstrap) return;

    if (!hasConfirmedName) {
      setShowUsernameModal(true);
      return;
    }

    if (joinedRef.current) return;
    joinedRef.current = true;
    joinRoom({ roomCode, playerId: user.playerId, username: user.username, avatarSeed: user.avatarSeed })
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
    if (!isHost) return;
    const snap = bootstrapRef.current || bootstrap;
    const snapRoom = snap?.room;
    if (!snapRoom) return;
    const nextIdx = snapRoom.current_round_index + 1;
    const total = snapRoom.quiz_payload?.questions?.length ?? 0;
    if (nextIdx >= total) return; // last question — no auto-advance

    console.log("[DEBUG] Starting auto-advance countdown to round:", nextIdx);
    let sec = 2;
    setAutoSec(sec);
    autoTimerRef.current = setInterval(() => {
      sec -= 1;
      setAutoSec(sec);
      if (sec <= 0) {
        clearInterval(autoTimerRef.current);
        const u = userRef.current || user;
        if (!u) {
          console.error("[DEBUG] Auto-advance failed: user profile is null");
          return;
        }
        console.log("[DEBUG] Auto-advance: advancing to round:", nextIdx);
        startRound({ roomCode, hostPlayerId: u.playerId, roundIndex: nextIdx }, hostSecret)
          .then(() => {
            console.log("[DEBUG] Auto-advance startRound success, refreshing...");
            return refreshBootstrap();
          })
          .catch(err => {
            console.error("[DEBUG] Auto-advance failed:", err);
            setMsg(`Auto-advance failed: ${err.message}`);
          });
      }
    }, 1000);
    return () => clearInterval(autoTimerRef.current);
  }, [phase, isHost, bootstrap]);

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

  // ── Đã submit + mọi active player cũng đã submit → chuyển results NGAY (bỏ đếm ngược) ──
  useEffect(() => {
    if (phase !== "won_waiting" || !room) return;
    if (!submittedRef.current) return;
    const activePlayers = players.filter(p => !p.is_bankrupt);
    if (activePlayers.length === 0) return;
    const allSubmitted = activePlayers.every(p => p.last_round_submitted === room.current_round_index);
    if (allSubmitted) {
      clearInterval(timerRef.current);
      // Người hit target sớm mới chỉ ở won_waiting, roundResult còn null →
      // phải fireSubmit để TÍNH + setRoundResult, nếu không RunnerScene không render (trắng màn).
      if (!roundResult) {
        fireSubmit();
      } else {
        syncPhase(roundResult.bankrupt ? "bankrupt" : "results");
        refreshBootstrap(true);
      }
    }
  }, [bootstrap, phase, room, players, roundResult]);

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

    // Determine if this is a genuinely NEW round vs the same round's deadline being shortened (early end)
    const currentRoundIdx = room.current_round_index ?? 0;
    const isNewRound = currentRoundIdx !== prevRoundIdxRef.current;
    prevRoundIdxRef.current = currentRoundIdx;

    if (isNewRound) {
      // ── Full reset for a brand-new round ──
      submittedRef.current = false;
      didFireSubmitRef.current = false;
      localWinRef.current  = null;
      lastClickRef.current = null;
      lastGaugeRef.current = null;
      startMsRef.current   = Date.now();
      setRoundResult(null);
      setReviewQuestionIndex(null);
      setPlayerClicks([]);
      setBlankAnswers({});
      syncPhase("active");
      setShowOverlay(true);
      setShowAnswersCanvas(false);
      setHasSubmittedLocal(false);
      setMsg("Round started! Find the hidden target zone.");
    }
    // else: same round, deadline was just adjusted (early end by host).
    //       Do NOT reset localWinRef / lastClickRef / phase — the player's
    //       click result must be preserved.

    // (Re)start the countdown timer regardless
    clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      const left = new Date(room.round_deadline_at).getTime() - Date.now();
      setRemainingMs(Math.max(0, left));
      if (left <= 0) {
        clearInterval(timerRef.current);
        if (didFireSubmitRef.current && roundResult) {
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

    // Ignore gauge-only updates — these fire on DoodleCanvas mount/slider change
    // and must NOT trigger click/submit logic
    if (payload.isGaugeUpdate) {
      lastGaugeRef.current = (payload.gaugeValue !== undefined && payload.gaugeValue !== null) ? payload.gaugeValue : null;
      return;
    }

    // Reject invalid coordinates (null/undefined)
    if (typeof payload.rx !== "number" || typeof payload.ry !== "number") return;

    // Check if it is a multi-click question (more than 1 correct zones)
    const correctZones = question?.elements?.filter(el =>
      (el.type === "PRECISION_TARGET" || el.type === "FREEFORM_ZONE") && el.role !== "DECOY"
    ) ?? [];
    const isMultiple = correctZones.length > 1;

    if (isMultiple) {
      setPlayerClicks(prev => {
        if (prev.length >= correctZones.length) return prev;
        const newClicks = [...prev, { rx: payload.rx, ry: payload.ry, isLocalHit: payload.isLocalHit }];
        return newClicks;
      });
      lastGaugeRef.current = (payload.gaugeValue !== undefined && payload.gaugeValue !== null) ? payload.gaugeValue : null;
    } else {
      lastClickRef.current = { rx: payload.rx, ry: payload.ry };
      lastGaugeRef.current = (payload.gaugeValue !== undefined && payload.gaugeValue !== null) ? payload.gaugeValue : null;
      localWinRef.current = payload.isLocalHit;
      submittedRef.current = true;
      setHasSubmittedLocal(true);

      // Update submission status in database to notify the host
      const currentMe = bootstrap?.players?.find(p => p.player_id === user?.playerId);
      if (currentMe && room) {
        updatePlayerBalance(user.playerId, roomCode, currentMe.balance, currentMe.is_bankrupt, room.current_round_index).then();
      }
    }
  }

  const playerClicksRef = useRef([]);
  const blankAnswersRef = useRef({});

  useEffect(() => {
    playerClicksRef.current = playerClicks;
  }, [playerClicks]);

  useEffect(() => {
    blankAnswersRef.current = blankAnswers;
  }, [blankAnswers]);

  function checkAnswersLocal() {
    const clicks = playerClicksRef.current;
    const blanks = blankAnswersRef.current;
    const correctZones = question?.elements?.filter(el =>
      (el.type === "PRECISION_TARGET" || el.type === "FREEFORM_ZONE") && el.role !== "DECOY"
    ) ?? [];

    let zonesOk = true;
    if (correctZones.length > 0) {
      if (clicks.length !== correctZones.length) {
        zonesOk = false;
      } else if (question?.requireSequence) {
        let seqOk = true;
        for (let i = 0; i < correctZones.length; i++) {
          const click = clicks[i];
          const zone = correctZones[i];
          let hit = false;
          if (click && click.isLocalHit) {
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
          }
          if (!hit) {
            seqOk = false;
            break;
          }
        }
        zonesOk = seqOk;
      } else {
        const visited = new Array(correctZones.length).fill(false);
        function match(clickIdx) {
          if (clickIdx === clicks.length) return true;
          const click = clicks[clickIdx];
          if (!click || !click.isLocalHit) return false;

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
        zonesOk = match(0);
      }
    }

    const gaugeEl = question?.elements?.find(el => el.type === "GAUGE_BLOCK");
    let gaugeOk = true;
    if (gaugeEl) {
      const gaugeValue = lastGaugeRef.current !== undefined && lastGaugeRef.current !== null
        ? lastGaugeRef.current
        : (gaugeEl?.labels ? gaugeEl.labels.split(",")[0]?.trim() : 50);

      if (gaugeEl.labels) {
        const correctVal = gaugeEl.correctValue ?? gaugeEl.labels.split(",")[0]?.trim();
        gaugeOk = String(gaugeValue).trim() === String(correctVal).trim();
      } else {
        const correctMin = typeof gaugeEl.correctMin === "number" ? gaugeEl.correctMin : (Number(gaugeEl.correctValue) || gaugeEl.min || 0);
        const correctMax = typeof gaugeEl.correctMax === "number" ? gaugeEl.correctMax : (Number(gaugeEl.correctValue) || gaugeEl.max || 100);
        const valNum = Number(gaugeValue);
        gaugeOk = !isNaN(valNum) && valNum >= correctMin && valNum <= correctMax;
      }
    }

    const blankBlocks = question?.elements?.filter(el => el.type === "BLANK_BLOCK") ?? [];
    let blanksOk = true;
    if (blankBlocks.length > 0) {
      const normalizeStr = (str) => {
        if (!str) return "";
        return str
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/\s+/g, " ")
          .trim();
      };

      for (const block of blankBlocks) {
        const playerVal = normalizeStr(blanks[block.id]);
        const correctVals = (block.correctText ?? "")
          .split(",")
          .map(v => normalizeStr(v))
          .filter(Boolean);
        
        if (correctVals.length > 0) {
          const isCorrect = correctVals.some(c => c === playerVal);
          if (!isCorrect) {
            blanksOk = false;
            break;
          }
        }
      }
    }

    return zonesOk && gaugeOk && blanksOk;
  }

  const handleMultiSubmit = () => {
    const finalWin = checkAnswersLocal();

    lastClickRef.current = playerClicks[0] || { rx: 0.5, ry: 0.5 };
    localWinRef.current = finalWin;
    submittedRef.current = true;
    setHasSubmittedLocal(true);

    // Update submission status in database to notify the host
    const currentMe = bootstrap?.players?.find(p => p.player_id === user?.playerId);
    if (currentMe && room) {
      updatePlayerBalance(user.playerId, roomCode, currentMe.balance, currentMe.is_bankrupt, room.current_round_index).then();
    }
  };

  // ── Batch submit — reads refs, NOT stale state closure ───────────────────────
  async function fireSubmit() {
    if (didFireSubmitRef.current) return;
    didFireSubmitRef.current = true;
    submittedRef.current = true;

    const snap     = bootstrapRef.current;
    const snapMe   = snap?.players?.find(p => p.player_id === user?.playerId);
    const snapRoom = snap?.room;

    if (!snapMe || !snapRoom) { syncPhase("results"); return; }
    if (snapMe.is_bankrupt)   { syncPhase("bankrupt"); return; }

    syncPhase("submitting");

    // Fallback evaluation when the player runs out of time without submitting
    if (localWinRef.current === null || localWinRef.current === undefined) {
      localWinRef.current = checkAnswersLocal();
    }

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

  async function hostStartQuiz() {
    console.log("[DEBUG] Clicked hostStartQuiz", { isHost, roomExists: !!room, userExists: !!user });
    if (!isHost) {
      console.warn("[DEBUG] hostStartQuiz ignored: not a host");
      return;
    }
    let currentRoom = room;
    // If bootstrap hasn't loaded yet, fetch it now
    if (!currentRoom) {
      console.log("[DEBUG] hostStartQuiz: room data is null, fetching bootstrap...");
      setMsg("Loading room data...");
      const data = await refreshBootstrap(false, 3);
      currentRoom = data?.room;
      if (!currentRoom) {
        console.error("[DEBUG] hostStartQuiz: failed to load room data");
        setMsg("Failed to load room data.");
        return;
      }
    }
    const currentUser = userRef.current || user || getOrCreateUser();
    if (!currentUser || !currentUser.playerId) {
      console.error("[DEBUG] hostStartQuiz: user profile not initialized");
      setMsg("Failed to start: User profile is not initialized.");
      return;
    }
    try {
      console.log("[DEBUG] hostStartQuiz: starting round 0 via startRound...", {
        roomCode,
        hostPlayerId: currentUser.playerId,
        hostSecret
      });
      await startRound({ roomCode, hostPlayerId: currentUser.playerId, roundIndex: 0 }, hostSecret);
      console.log("[DEBUG] hostStartQuiz: startRound successful, refreshing bootstrap...");
      await refreshBootstrap();
    } catch (err) {
      console.error("[DEBUG] hostStartQuiz: failed to start round", err);
      setMsg(`Start failed: ${err.message}`);
    }
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
    console.log("[DEBUG] endRoom: redirecting to '/' instantly...");
    router.push("/");
    cleanupRoom({ roomCode, hostPlayerId: user.playerId }, hostSecret)
      .then(() => console.log("[DEBUG] endRoom: database cleanup successful"))
      .catch(err => console.error("[DEBUG] endRoom: database cleanup failed:", err));
  }

  async function handleLeave() {
    if (!roomCode || !user) return;
    console.log("[DEBUG] handleLeave: redirecting to '/' instantly...");
    router.push("/");
    if (isHost) {
      cleanupRoom({ roomCode, hostPlayerId: user.playerId }, hostSecret)
        .then(() => console.log("[DEBUG] handleLeave: host database cleanup successful"))
        .catch(err => console.error("[DEBUG] handleLeave: host database cleanup failed:", err));
    } else {
      deletePlayer(user.playerId, roomCode)
        .then(() => console.log("[DEBUG] handleLeave: player delete successful"))
        .catch(err => console.error("[DEBUG] handleLeave: player delete failed:", err));
    }
  }

  const hasGauge = question?.elements?.some(el => el.type === "GAUGE_BLOCK");
  const canvasMaxWidth = hasGauge ? "calc(100vh - 110px)" : "calc(100vh - 55px)";

  return (
    <>
      <main className="room-shell">
        <section className="room-grid">
          {/* ── Canvas area (Left Column: Full Height 1:1, pushed to left) ────────────────────── */}
          <div className="room-canvas-col">
            {phase === "lobby" && !room?.round_deadline_at ? (
              /* ── Lobby Waiting Screen ── */
              <div style={{
                width: "min(100%, calc((16 / 9) * (100vh - 32px)))",
                aspectRatio: "16 / 9",
                border: "3px solid var(--ink)",
                borderRadius: 18,
                background: "white",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 16,
                textAlign: "center",
                padding: 32,
                boxSizing: "border-box",
              }}>
                <div style={{ fontSize: "4rem", lineHeight: 1 }}>🎨</div>
                <h2 style={{ fontFamily: "Itim, cursive", margin: 0, fontSize: "1.8rem", color: "var(--ink)" }}>
                  Sẵn sàng chơi!
                </h2>
                <p style={{ margin: 0, opacity: 0.6, fontSize: "1rem", maxWidth: 320 }}>
                  {isHost
                    ? "Bấm Start Quiz ở bảng bên phải để bắt đầu."
                    : "Đợi host bắt đầu quiz nhé..."}
                </p>
                <div style={{
                  margin: "8px 0",
                  background: "#fef2f2",
                  border: "2px solid #ef4444",
                  borderRadius: 10,
                  padding: "6px 10px",
                  fontSize: "0.82rem",
                  fontWeight: "bold",
                  color: "#991b1b",
                  fontFamily: "Itim, cursive",
                  maxWidth: 320
                }}>
                  🏆 Ai có NHIỀU xu nhất sẽ CHIẾN THẮNG!
                </div>
                <div style={{
                  display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center", marginTop: 4
                }}>
                  <span className="badge" style={{ fontSize: "0.9rem" }}>👥 {players.length} người chơi</span>
                  <span className="badge" style={{ fontSize: "0.9rem" }}>📝 {totalQ} câu hỏi</span>
                </div>
              </div>
            ) : (
              /* ── Active Game Canvas ── */
              <div style={{ position: "relative", width: "min(100%, calc((16 / 9) * (100vh - 32px)))", aspectRatio: "16 / 9" }}>
                
                {/* Single, permanently mounted RunnerScene at the bottom */}
                <RunnerScene
                  me={me}
                  players={players}
                  isHost={isHost}
                  isLocalWin={localWinRef.current}
                  roundResult={phase === "results" ? roundResult : null}
                  animateProgress={phase === "results" ? animateProgress : false}
                  currentRoundIndex={room?.current_round_index ?? 0}
                  phase={phase}
                  questionOpen={revealQuestion && phase === "active"}
                  totalQ={totalQ}
                  remainingMs={remainingMs}
                  roundDuration={room?.round_duration_sec || 20}
                >
                  {phase === "results" && roundResult && showOverlay && animateProgress && (
                    <div style={{
                      flex: 1,
                      display: "flex",
                      flexDirection: "column",
                      justifyContent: "center",
                      alignItems: "center",
                      zIndex: 15
                    }}>
                      <div style={{
                        background: "rgba(30, 27, 75, 0.85)",
                        border: roundResult.resulting_is_win ? "3px solid #10b981" : "3px solid #ef4444",
                        borderRadius: 24,
                        padding: "20px 30px",
                        boxShadow: roundResult.resulting_is_win ? "0 0 20px rgba(16,185,129,0.35)" : "0 0 20px rgba(239,68,68,0.35)",
                        textAlign: "center",
                        maxWidth: 380,
                        width: "100%",
                        boxSizing: "border-box"
                      }}>
                        {roundResult.resulting_is_win ? (
                          <>
                            <div style={{ fontSize: "3rem", lineHeight: 1 }}>✨</div>
                            <h2 style={{ fontFamily: "Itim, cursive", margin: "6px 0 2px", fontSize: "1.6rem" }}>ROUND WIN!</h2>
                            <p style={{ margin: "2px 0", fontSize: "0.88rem", opacity: 0.8 }}>RNG ×{Number(roundResult.rng_factor ?? 0).toFixed(2)}</p>
                            <p style={{ fontSize: "1.3rem", fontWeight: "bold", margin: "4px 0", color: "#10b981" }}>+{roundResult.delta} coins</p>
                          </>
                        ) : (
                          <>
                            <div style={{ fontSize: "3rem", lineHeight: 1 }}>{roundResult.anti_cheat ? "🚨" : "💀"}</div>
                            <h2 style={{ fontFamily: "Itim, cursive", margin: "6px 0 2px", fontSize: "1.6rem" }}>
                              {roundResult.anti_cheat ? "ANTI-CHEAT TRIGGERED" : "ROUND LOSS"}
                            </h2>
                            {roundResult.anti_cheat && (
                              <p style={{ fontSize: "0.78rem", opacity: 0.75, margin: "2px 0" }}>Bet was invalid. Balance reset to 0.</p>
                            )}
                            <p style={{ fontSize: "1.3rem", fontWeight: "bold", margin: "4px 0", color: "#ef4444" }}>{roundResult.delta} coins</p>
                          </>
                        )}
                        <p style={{ marginTop: 4, marginBottom: 8, opacity: 0.85, fontSize: "0.9rem" }}>
                          Balance: <strong>{roundResult.resulting_balance}</strong> coins
                        </p>

                        <div style={{ display: "flex", gap: 10, width: "100%", marginTop: 8, flexDirection: "column" }}>
                          <div style={{ display: "flex", gap: 10, width: "100%" }}>
                            <button
                              type="button"
                              className="btn secondary"
                              style={{
                                flex: 1,
                                background: "var(--mint)",
                                color: "var(--ink)",
                                padding: "6px 10px",
                                fontSize: "0.85rem",
                                fontWeight: "bold"
                              }}
                              onClick={() => setShowAnswersCanvas(true)}
                            >
                              👁 Xem đáp án (View Canvas)
                            </button>
                            
                            <button
                              type="button"
                              className="btn secondary"
                              style={{
                                flex: 1,
                                background: "rgba(255, 255, 255, 0.2)",
                                color: "white",
                                borderColor: "rgba(255, 255, 255, 0.4)",
                                padding: "6px 10px",
                                fontSize: "0.85rem"
                              }}
                              onClick={() => setShowOverlay(false)}
                            >
                              ❌ Đóng (Close)
                            </button>
                          </div>
                          
                          {isHost && room?.current_round_index + 1 >= totalQ && (
                            <button
                              type="button"
                              className="btn danger"
                              style={{ flex: 1, padding: "5px 10px", fontSize: "0.85rem" }}
                              onClick={endRoom}
                            >
                              🏁 End Room
                            </button>
                          )}
                        </div>

                        {isHost && room?.current_round_index + 1 < totalQ && autoSec > 0 && (
                          <p style={{ marginTop: 8, opacity: 0.85, fontSize: "0.82rem", margin: "8px 0 0" }}>⏭ Next question in <strong>{autoSec}s</strong>...</p>
                        )}
                        {!isHost && (
                          <p style={{ marginTop: 8, opacity: 0.65, fontSize: "0.82rem", margin: "8px 0 0" }}>Waiting for next question...</p>
                        )}
                      </div>
                    </div>
                  )}
                </RunnerScene>

                {question && !(phase === "results" || phase === "bankrupt" || isGameFinished) ? (
                  <div
                    style={phase === "active" && revealQuestion ? {
                      /* QUESTION POPUP — floats above the runner scene khi chướng ngại vật tới gần */
                      position: "absolute",
                      inset: "3% 4%",
                      zIndex: 120,
                      background: "#fffdf7",
                      border: "3px solid var(--ink)",
                      borderRadius: 18,
                      boxShadow: "0 14px 44px rgba(0,0,0,0.45)",
                      padding: 12,
                      boxSizing: "border-box",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      overflow: "auto",
                      animation: "question-pop-in 0.45s cubic-bezier(0.34, 1.56, 0.64, 1) both"
                    } : { display: "none" }}
                  >
                    <DoodleCanvas
                      key={activeQuestionIndex}
                      question={question}
                      disabled={canvasDisabled}
                      onSolve={onCanvasSolve}
                      isCreator={false}
                      revealAnswers={phase === "results" || phase === "bankrupt" || isGameFinished}
                      playerClicks={playerClicks}
                      blankAnswers={blankAnswers}
                      onBlankChange={(id, val) => setBlankAnswers(prev => ({ ...prev, [id]: val }))}
                      style={{ maxWidth: "100%" }}
                    />

                    {hasSubmittedLocal && (
                      <div style={{
                        position: "absolute",
                        inset: 0,
                        background: "rgba(30, 27, 75, 0.82)",
                        backdropFilter: "blur(6px)",
                        borderRadius: 15,
                        zIndex: 10,
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "white",
                        fontFamily: "Itim, cursive",
                        textAlign: "center",
                        gap: 12,
                      }}>
                        <div style={{ fontSize: "3.5rem", animation: "rs-run 0.5s ease-in-out infinite" }}>📥</div>
                        <h3 style={{ margin: 0, fontSize: "1.6rem", color: "#ffd7ba" }}>ĐÃ GỬI BÀI LÀM!</h3>
                        <p style={{ margin: 0, opacity: 0.85, fontSize: "1rem" }}>Đang chờ đối thủ hoàn thành...</p>
                        <p style={{ margin: 0, opacity: 0.5, fontSize: "0.9rem" }}>⏱ Hết giờ sau {(remainingMs / 1000).toFixed(0)}s</p>
                      </div>
                    )}
                  </div>
                ) : question ? (
                  <div className="doodle-board" style={{ minHeight: 200 }} />
                ) : (
                  <div className="doodle-board" style={{ minHeight: 200, display: "grid", placeItems: "center", opacity: 0.4 }}>
                    <p>No question active</p>
                  </div>
                )}

                {/* SUBMITTED STATUS BAR */}
                {phase === "won_waiting" && (
                  <div style={{
                    position: "absolute",
                    top: 16,
                    left: "50%",
                    transform: "translateX(-50%)",
                    zIndex: 110,
                    background: "rgba(30, 27, 75, 0.85)",
                    backdropFilter: "blur(8px)",
                    border: "2px solid rgba(255, 255, 255, 0.2)",
                    borderRadius: 20,
                    padding: "8px 18px",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    color: "white",
                    fontFamily: "Itim, cursive",
                    boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
                    fontSize: "0.95rem"
                  }}>
                    <span>📥</span>
                    <span>Đã nộp! Đang chờ người khác... ({ (remainingMs / 1000).toFixed(0) }s)</span>
                  </div>
                )}

                {/* TIME OUT STATUS BAR */}
                {phase === "submitting" && (
                  <div style={{
                    position: "absolute",
                    top: 16,
                    left: "50%",
                    transform: "translateX(-50%)",
                    zIndex: 110,
                    background: "rgba(26, 26, 26, 0.85)",
                    backdropFilter: "blur(8px)",
                    border: "2px solid rgba(255, 255, 255, 0.2)",
                    borderRadius: 20,
                    padding: "8px 18px",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    color: "white",
                    fontFamily: "Itim, cursive",
                    boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
                    fontSize: "0.95rem"
                  }}>
                    <span>⏳</span>
                    <span>Hết giờ! Đang lưu kết quả...</span>
                  </div>
                )}

                {/* BANKRUPT */}
                {phase === "bankrupt" && showOverlay && (
                  <div style={{ ...overlayBase, zIndex: 110, background: "linear-gradient(135deg,#7f1d1df0,#450a0af0)", borderRadius: 18 }}>
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

                {showAnswersCanvas && question && (
                  <div style={{
                    position: "absolute",
                    inset: "3% 4%",
                    zIndex: 130,
                    background: "#fffdf7",
                    border: "3px solid var(--ink)",
                    borderRadius: 18,
                    boxShadow: "0 14px 44px rgba(0,0,0,0.55)",
                    padding: 16,
                    boxSizing: "border-box",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 12,
                  }}>
                    <div style={{ display: "flex", width: "100%", justifyContent: "space-between", alignItems: "center", borderBottom: "2px dashed var(--ink)", paddingBottom: 6 }}>
                      <span style={{ fontFamily: "Itim, cursive", fontSize: "1.2rem", color: "var(--ink)", fontWeight: "bold" }}>
                        👁 Xem Đáp Án Câu Hỏi (Answers)
                      </span>
                      <button
                        type="button"
                        className="btn danger"
                        style={{ padding: "4px 12px", fontSize: "0.85rem" }}
                        onClick={() => setShowAnswersCanvas(false)}
                      >
                        ❌ Đóng (Close)
                      </button>
                    </div>
                    <div style={{ flex: 1, width: "100%", display: "flex", alignItems: "center", justifyContent: "center", overflow: "auto" }}>
                      <DoodleCanvas
                        question={question}
                        disabled={true}
                        revealAnswers={true}
                        playerClicks={playerClicks}
                        blankAnswers={blankAnswers}
                        style={{ maxWidth: "100%" }}
                      />
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
            )}
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
                {room?.round_deadline_at && <span className="badge">⏱ {(remainingMs / 1000).toFixed(1)}s</span>}
                {room?.round_deadline_at && <span className="badge">Q {(room?.current_round_index ?? 0) + 1}/{totalQ || "?"}</span>}
                {!isHost && <span className="badge">💰 {myBalance} coins</span>}
                {isHost && <span className="badge" style={{ background: "#c6f7e2" }}>HOST 👑</span>}
                {!isHost && isBankrupt && <span className="badge" style={{ background: "#ff6b6b", color: "white" }}>BANKRUPT</span>}
              </div>

              {/* Only show question section after quiz has started */}
              {!(phase === "lobby" && !room?.round_deadline_at) && (
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
              )}
            </article>

            {/* Host Controls for Lobby & Results */}
            {isHost && (phase === "lobby" || phase === "results") && (
              <div className="card" style={{ background: "#fff8e8", border: "2px dashed #2f2a3c", padding: "10px 12px" }}>
                <h4 style={{ margin: "0 0 6px", fontSize: "1.05rem" }}>👑 Host Controls</h4>
                {phase === "lobby" && !room?.round_deadline_at && (
                  <button type="button" className="btn" style={{ width: "100%" }} onClick={hostStartQuiz} disabled={!room}>
                    {!room ? "⏳ Loading..." : "🚀 Start Quiz"}
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
              const hasGauge = question?.elements?.some(el => el.type === "GAUGE_BLOCK");
              const hasBlanks = question?.elements?.some(el => el.type === "BLANK_BLOCK");
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
                  {hasGauge ? (
                    <div style={{ marginTop: 8 }}>
                      <p style={{ margin: "0 0 8px", fontWeight: "bold", color: "#7c3aed", fontSize: "0.85rem", lineHeight: 1.4 }}>
                        📊 CÂU HỎI KÉO THƯỚC ĐO:
                        <br />
                        Kéo thanh trượt trên thước đo đến giá trị đúng, rồi bấm nút dưới!
                      </p>
                      <button type="button" className="btn" style={{ width: "100%", padding: "8px 12px" }}
                        onClick={handleMultiSubmit}>
                        Gửi đáp án 🚀
                      </button>
                    </div>
                  ) : hasBlanks ? (
                    <div style={{ marginTop: 8 }}>
                      <p style={{ margin: "0 0 8px", fontWeight: "bold", color: "#7c3aed", fontSize: "0.85rem", lineHeight: 1.4 }}>
                        ✏️ CÂU HỎI ĐIỀN VÀO CHỖ TRỐNG:
                        <br />
                        Nhập câu trả lời vào ô trống trên bảng vẽ, rồi bấm nút dưới!
                      </p>
                      <button type="button" className="btn" style={{ width: "100%", padding: "8px 12px" }}
                        onClick={handleMultiSubmit}>
                        Gửi đáp án 🚀
                      </button>
                    </div>
                  ) : isMultiple ? (
                    <div style={{ marginTop: 8 }}>
                      <p style={{ margin: "0 0 8px", fontWeight: "bold", color: "#7c3aed", fontSize: "0.85rem", lineHeight: 1.4 }}>
                        {question?.requireSequence ? (
                          <>
                            🧩 YÊU CẦU CLICK ĐÚNG THỨ TỰ:
                            <br />
                            Hãy click vào các target zone theo thứ tự từ 1 đến {correctZones.length}!
                          </>
                        ) : (
                          <>
                            🧩 CÂU HỎI NHIỀU VÙNG CHỌN:
                            <br />
                            Hãy click vào tất cả {correctZones.length} vùng chọn đúng (theo thứ tự bất kỳ)!
                          </>
                        )}
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
            {isHost && phase === "active" && (() => {
              const activePlayers = players.filter(p => !p.is_bankrupt);
              const submittedCount = activePlayers.filter(p => p.last_round_submitted === (room?.current_round_index ?? 0)).length;
              return (
              <div className="card" style={{ background: "#c6f7e2", borderStyle: "dashed", padding: "10px 12px" }}>
                <h4 style={{ margin: "0 0 4px", fontSize: "1.05rem" }}>🎯 Round Active</h4>
                <p style={{ margin: 0, fontSize: "0.85rem", opacity: 0.8 }}>
                  Đã trả lời: <strong>{submittedCount}/{activePlayers.length}</strong> người chơi
                </p>
              </div>
              );
            })()}

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
                            <img
                              src={`/characters/${p.avatar_seed && p.avatar_seed !== "P" && !isNaN(Number(p.avatar_seed)) ? p.avatar_seed : "1"}.png`}
                              alt=""
                              style={{ width: 26, height: 26, objectFit: "contain", marginRight: 2 }}
                            />
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
                            <img src={`/characters/${p.avatar_seed && p.avatar_seed !== "P" && !isNaN(Number(p.avatar_seed)) ? p.avatar_seed : "1"}.png`} style={{ width: 22, height: 22, objectFit: "contain", marginRight: 2 }} alt="" />
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
            maxWidth: 440,
            display: "flex",
            flexDirection: "column",
            gap: 14,
            textAlign: "center",
            padding: "24px 20px"
          }}>
            <h2 style={{ fontFamily: "Itim, cursive", margin: 0, fontSize: "1.7rem" }}>
              Thiết lập Nhân vật 🎨
            </h2>
            
            {/* Avatar Preview */}
            <div style={{ display: "flex", justifyContent: "center", margin: "4px 0" }}>
              <div style={{
                width: 80,
                height: 80,
                borderRadius: "50%",
                background: "#fffaf0",
                border: "3px solid #2f2a3c",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                boxShadow: "0 4px 8px rgba(0,0,0,0.1)",
                animation: "avatar-jump 0.8s ease-in-out infinite",
              }}>
                <img
                  src={`/characters/${selectedCharacter}.png`}
                  alt="Avatar Preview"
                  style={{ width: 64, height: 64, objectFit: "contain" }}
                />
              </div>
            </div>

            <input
              type="text"
              className="input"
              placeholder="Biệt danh của bạn..."
              required
              value={usernameInput}
              onChange={e => setUsernameInput(e.target.value)}
              autoFocus
              maxLength={15}
              style={{ textAlign: "center", fontSize: "1.1rem", fontWeight: "bold" }}
            />

            <p style={{ margin: "4px 0 2px", fontWeight: "bold", fontSize: "0.9rem", color: "#7c3aed", textAlign: "left" }}>
              👉 Chọn con vật đại diện của bạn (36 lựa chọn):
            </p>

            {/* Character grid */}
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(6, 1fr)",
              gap: 8,
              maxHeight: 180,
              overflowY: "auto",
              padding: 8,
              border: "2px dashed #ccc",
              borderRadius: 12,
              background: "#fffaf0",
              boxSizing: "border-box"
            }}>
              {Array.from({ length: 36 }).map((_, idx) => {
                const id = idx + 1;
                const isSelected = selectedCharacter === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setSelectedCharacter(id)}
                    style={{
                      width: "100%",
                      aspectRatio: "1/1",
                      border: isSelected ? "3px solid #7c3aed" : "2px solid #2f2a3c",
                      borderRadius: 8,
                      padding: 2,
                      background: isSelected ? "#f5f3ff" : "#fff",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      transform: isSelected ? "scale(1.08)" : "none",
                      transition: "transform 0.15s ease",
                      boxSizing: "border-box"
                    }}
                  >
                    <img
                      src={`/characters/${id}.png`}
                      alt={`Char ${id}`}
                      style={{ width: "100%", height: "100%", objectFit: "contain" }}
                    />
                  </button>
                );
              })}
            </div>

            <button type="submit" className="btn" style={{ fontSize: "1.1rem", marginTop: 6 }}>
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

      {isAdminMode && (
        <div style={{
          position: "fixed",
          bottom: 20,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 99999,
          background: "rgba(17, 24, 39, 0.98)",
          border: "3px solid #10b981",
          borderRadius: 16,
          boxShadow: "0 20px 50px rgba(0,0,0,0.8), 0 0 15px rgba(16, 185, 129, 0.4)",
          padding: "16px 20px",
          display: "flex",
          flexDirection: "column",
          gap: 12,
          width: "95%",
          maxWidth: 960,
          boxSizing: "border-box",
          color: "#fff",
          fontFamily: "Fredoka, sans-serif"
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontWeight: "bold", fontSize: "0.95rem", color: "#10b981", letterSpacing: 0.5 }}>
              🛠 DEVELOPER SANDBOX CONTROL PANEL
            </span>
            <button
              onClick={() => {
                setSandboxState(null);
                setIsAdminMode(false);
                localStorage.setItem("cutequiz:admin_mode", "false");
              }}
              style={{
                background: "#ef4444",
                color: "#fff",
                border: "none",
                borderRadius: 8,
                padding: "4px 10px",
                fontSize: "0.75rem",
                cursor: "pointer",
                fontWeight: "bold"
              }}
            >
              Close Admin Mode
            </button>
          </div>
          
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              className="btn secondary"
              style={{ padding: "6px 12px", fontSize: "0.8rem", background: sandboxState?.id === "lobby" ? "#3b82f6" : "rgba(255,255,255,0.1)" }}
              onClick={() => setSandboxState({
                id: "lobby",
                phase: "lobby",
                revealQuestion: false,
                isGameFinished: false,
                showOverlay: true
              })}
            >
              🚪 Lobby
            </button>

            <button
              className="btn secondary"
              style={{ padding: "6px 12px", fontSize: "0.8rem", background: sandboxState?.id === "active_run" ? "#3b82f6" : "rgba(255,255,255,0.1)" }}
              onClick={() => setSandboxState({
                id: "active_run",
                phase: "active",
                revealQuestion: false,
                isGameFinished: false,
                showOverlay: true
              })}
            >
              🏃‍♂️ Runner Intro
            </button>

            <button
              className="btn secondary"
              style={{ padding: "6px 12px", fontSize: "0.8rem", background: sandboxState?.id === "q_precision" ? "#3b82f6" : "rgba(255,255,255,0.1)" }}
              onClick={() => setSandboxState({
                id: "q_precision",
                phase: "active",
                revealQuestion: true,
                isGameFinished: false,
                showOverlay: false,
                question: mockPrecisionQ
              })}
            >
              🎯 Q: Precision Target
            </button>

            <button
              className="btn secondary"
              style={{ padding: "6px 12px", fontSize: "0.8rem", background: sandboxState?.id === "q_gauge" ? "#3b82f6" : "rgba(255,255,255,0.1)" }}
              onClick={() => setSandboxState({
                id: "q_gauge",
                phase: "active",
                revealQuestion: true,
                isGameFinished: false,
                showOverlay: false,
                question: mockGaugeQ
              })}
            >
              🎛 Q: Gauge Slider
            </button>

            <button
              className="btn secondary"
              style={{ padding: "6px 12px", fontSize: "0.8rem", background: sandboxState?.id === "q_blanks" ? "#3b82f6" : "rgba(255,255,255,0.1)" }}
              onClick={() => setSandboxState({
                id: "q_blanks",
                phase: "active",
                revealQuestion: true,
                isGameFinished: false,
                showOverlay: false,
                question: mockBlanksQ
              })}
            >
              ✏️ Q: Fill Blanks
            </button>

            <button
              className="btn secondary"
              style={{ padding: "6px 12px", fontSize: "0.8rem", background: sandboxState?.id === "submitted" ? "#3b82f6" : "rgba(255,255,255,0.1)" }}
              onClick={() => setSandboxState({
                id: "submitted",
                phase: "won_waiting",
                revealQuestion: true,
                isGameFinished: false,
                showOverlay: true
              })}
            >
              📥 Submitted
            </button>

            <button
              className="btn secondary"
              style={{ padding: "6px 12px", fontSize: "0.8rem", background: sandboxState?.id === "res_win" ? "#3b82f6" : "rgba(255,255,255,0.1)" }}
              onClick={() => setSandboxState({
                id: "res_win",
                phase: "results",
                revealQuestion: true,
                isGameFinished: false,
                showOverlay: true,
                roundResult: {
                  resulting_is_win: true,
                  delta: 15,
                  resulting_balance: 25,
                  rng_factor: 1.5
                }
              })}
            >
              ✨ Result: Win
            </button>

            <button
              className="btn secondary"
              style={{ padding: "6px 12px", fontSize: "0.8rem", background: sandboxState?.id === "res_loss" ? "#3b82f6" : "rgba(255,255,255,0.1)" }}
              onClick={() => setSandboxState({
                id: "res_loss",
                phase: "results",
                revealQuestion: true,
                isGameFinished: false,
                showOverlay: true,
                roundResult: {
                  resulting_is_win: false,
                  delta: -8,
                  resulting_balance: 4,
                  rng_factor: 0
                }
              })}
            >
              💀 Result: Loss
            </button>

            <button
              className="btn secondary"
              style={{ padding: "6px 12px", fontSize: "0.8rem", background: sandboxState?.id === "bankrupt" ? "#3b82f6" : "rgba(255,255,255,0.1)" }}
              onClick={() => setSandboxState({
                id: "bankrupt",
                phase: "bankrupt",
                revealQuestion: true,
                isGameFinished: false,
                showOverlay: true
              })}
            >
              💸 Bankrupt
            </button>

            <button
              className="btn secondary"
              style={{ padding: "6px 12px", fontSize: "0.8rem", background: sandboxState?.id === "podium" ? "#3b82f6" : "rgba(255,255,255,0.1)" }}
              onClick={() => setSandboxState({
                id: "podium",
                phase: "results",
                revealQuestion: true,
                isGameFinished: true,
                showOverlay: true,
                roundResult: {
                  resulting_is_win: true,
                  delta: 0,
                  resulting_balance: 10
                }
              })}
            >
              🏆 Final Podium
            </button>

            <button
              className="btn danger"
              style={{ padding: "6px 12px", fontSize: "0.8rem", marginLeft: "auto" }}
              onClick={() => setSandboxState(null)}
            >
              🔄 Reset Live Sync
            </button>
          </div>
        </div>
      )}
    </>
  );
}

