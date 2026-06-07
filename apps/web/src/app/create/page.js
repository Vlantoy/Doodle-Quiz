"use client";

import Link from "next/link";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { hostRoom } from "lib/api";
import { getOrCreateUser, saveUser, saveDraft, listDrafts, saveRoomState, randomUUID } from "lib/storage";
import DoodleCanvas from "components/DoodleCanvas";

// -- Quick-Start Template Presets (spec �5) -------------------------------------
// Static IDs only � no crypto.randomUUID() at module level (SSR safe)
const QUICK_TEMPLATES = [
  {
    id: "tpl-overlay-trap",
    title: "The Overlay Trap",
    questions: [{
      id: "tpl-ot-q1",
      prompt: "Hmm� something seems to be hiding behind that block. Can you find it?",
      canvasImage: "",
      zoomScale: 1.0,
      panOffset: { x: 0, y: 0 },
      elements: [
        {
          id: "tpl-ot-text",
          type: "TEXT_BLOCK",
          content: "Find the hidden coin! ??",
          x_ratio: 0.15, y_ratio: 0.08, w_ratio: 0.70, h_ratio: 0.10,
          isMovableByPlayer: false,
        },
        {
          id: "tpl-ot-answer",
          type: "ANSWER_BLOCK",
          content: "Move me if you can ??",
          x_ratio: 0.35, y_ratio: 0.38, w_ratio: 0.30, h_ratio: 0.14,
          isMovableByPlayer: true,
        },
        {
          id: "tpl-ot-target",
          type: "PRECISION_TARGET",
          x_ratio: 0.40, y_ratio: 0.40, w_ratio: 0.18, h_ratio: 0.10,
          isHidden: true,
        },
      ],
    }],
  },
  {
    id: "tpl-microscopic",
    title: "Microscopic Quest",
    questions: [{
      id: "tpl-micro-q1",
      prompt: "Something VERY tiny is hiding in a corner� zoom in and hunt! ??",
      canvasImage: "",
      zoomScale: 0.35,
      panOffset: { x: 0, y: 0 },
      elements: [
        {
          id: "tpl-micro-text",
          type: "TEXT_BLOCK",
          content: "Zoom in and find it! ??",
          x_ratio: 0.18, y_ratio: 0.05, w_ratio: 0.64, h_ratio: 0.09,
          isMovableByPlayer: false,
        },
        {
          id: "tpl-micro-target",
          type: "PRECISION_TARGET",
          x_ratio: 0.89, y_ratio: 0.87, w_ratio: 0.04, h_ratio: 0.04,
          isHidden: true,
        },
      ],
    }],
  },
  {
    id: "tpl-gauge",
    title: "Gauge Guess",
    questions: [{
      id: "tpl-gauge-q1",
      prompt: "Set the gauge between 37 and 44, then click anywhere on the canvas.",
      canvasImage: "",
      zoomScale: 1.0,
      panOffset: { x: 0, y: 0 },
      elements: [
        {
          id: "tpl-gauge-text",
          type: "TEXT_BLOCK",
          content: "Drag the slider to the correct range, then click!",
          x_ratio: 0.10, y_ratio: 0.10, w_ratio: 0.80, h_ratio: 0.10,
          isMovableByPlayer: false,
        },
        {
          id: "tpl-gauge-target",
          type: "PRECISION_TARGET",
          x_ratio: 0.05, y_ratio: 0.05, w_ratio: 0.90, h_ratio: 0.80,
          isHidden: true,
        },
        {
          id: "tpl-gauge-gauge",
          type: "GAUGE_BLOCK",
          min: 0, max: 100, correctMin: 37, correctMax: 44,
        },
      ],
    }],
  },
];

// -- Block palette definition -------------------------------------------------
const BLOCK_PALETTE = [
  {
    mode: "pan",
    icon: "🖐️",
    label: "Pan",
    description: "Drag to pan · Scroll to zoom",
    color: "#e0e7ff",
  },
  {
    mode: "draw-target",
    icon: "🔷",
    label: "Zone",
    description: "Draw a correct answer zone (freeform or rectangle)",
    color: "#d1fae5",
  },
  {
    mode: "draw-brush",
    icon: "🖌️",
    label: "Brush",
    description: "Freehand drawing on the canvas · pick a color and size below",
    color: "#fce7f3",
  },
  {
    mode: "place-text",
    icon: "📝",
    label: "Text Block",
    description: "Click canvas to place a static text label",
    color: "#fef3c7",
  },
  {
    mode: "place-answer",
    icon: "📦",
    label: "Cover Block",
    description: "Place a draggable cover block players must move to reveal the answer",
    color: "#dbeafe",
  },
];

function newQuestion() {
  return {
    id: randomUUID(),
    prompt: "",
    canvasImage: "",
    canvasImageFit: "contain",
    zoomScale: 1.0,
    panOffset: { x: 0, y: 0 },
    elements: [],
  };
}

// -----------------------------------------------------------------------------

export default function CreatePage() {
  const router = useRouter();

  const [title,            setTitle]            = useState("My Cute Trap Quiz");
  const [roundDurationSec, setRoundDurationSec] = useState(20);
  const [questions,        setQuestions]        = useState([newQuestion()]);
  const [selectedIdx,      setSelectedIdx]      = useState(0);
  const [canvasMode,       setCanvasMode]       = useState("pan");
  const [editingElemId,    setEditingElemId]    = useState(null);
  const [msg,              setMsg]              = useState("");
  const [brushColor,       setBrushColor]       = useState("#2f2a3c");
  const [brushWidth,       setBrushWidth]       = useState(3);
  const [brushMode,        setBrushMode]        = useState("normal");
  const [defaultZoneRole,  setDefaultZoneRole]  = useState("CORRECT_ANSWER");
  const [zoneDrawType,     setZoneDrawType]     = useState("freeform");
  const [draftId,          setDraftId]          = useState(() => randomUUID());
  const [showDrafts,       setShowDrafts]       = useState(false);
  const [savedDrafts,      setSavedDrafts]      = useState([]);

  const q = questions[selectedIdx];

  // -- Question array helpers ---------------------------------------------------
  function updateQ(patch) {
    setQuestions(prev => prev.map((item, i) => i === selectedIdx ? { ...item, ...patch } : item));
  }

  function addQuestion() {
    const nq = newQuestion();
    setQuestions(prev => [...prev, nq]);
    setSelectedIdx(questions.length);
  }

  function removeQuestion(idx) {
    if (questions.length <= 1) return;
    setQuestions(prev => prev.filter((_, i) => i !== idx));
    setSelectedIdx(s => Math.max(0, s >= idx ? s - 1 : s));
  }

  function loadTemplate(tpl) {
    setTitle(tpl.title);
    setQuestions(tpl.questions.map(item => ({ ...item, id: randomUUID() })));
    setSelectedIdx(0);
    setCanvasMode("pan");
    setMsg(`? Template "${tpl.title}" loaded.`);
  }

  // -- Element helpers ----------------------------------------------------------
  function removeElement(id) {
    updateQ({ elements: q.elements.filter(el => el.id !== id) });
  }

  function patchElement(id, patch) {
    updateQ({ elements: q.elements.map(el => el.id !== id ? el : { ...el, ...patch }) });
  }

  function layerUpElement(idx) {
    if (idx >= q.elements.length - 1) return;
    const newElements = [...q.elements];
    const temp = newElements[idx];
    newElements[idx] = newElements[idx + 1];
    newElements[idx + 1] = temp;
    updateQ({ elements: newElements });
  }

  function layerDownElement(idx) {
    if (idx <= 0) return;
    const newElements = [...q.elements];
    const temp = newElements[idx];
    newElements[idx] = newElements[idx - 1];
    newElements[idx - 1] = temp;
    updateQ({ elements: newElements });
  }

  function addGaugeBlock() {
    if (q.elements.some(el => el.type === "GAUGE_BLOCK")) {
      setMsg("?? This question already has a Gauge block.");
      return;
    }
    updateQ({
      elements: [...q.elements, {
        id: randomUUID(),
        type: "GAUGE_BLOCK",
        min: 0, max: 100, correctMin: 30, correctMax: 40,
      }],
    });
  }

  function onImageUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => updateQ({ canvasImage: ev.target.result });
    reader.readAsDataURL(file);
  }

  // -- Persist / host -----------------------------------------------------------
  function saveToDraft() {
    saveDraft({ id: draftId, title, questions, roundDurationSec, createdAt: Date.now() });
    setMsg("?? Saved!");
    setTimeout(() => setMsg(""), 2500);
  }

  function openDrafts() {
    setSavedDrafts(listDrafts());
    setShowDrafts(v => !v);
  }

  function loadDraft(d) {
    setTitle(d.title);
    setQuestions(d.questions.map(item => ({ ...item })));
    setRoundDurationSec(d.roundDurationSec ?? 20);
    setDraftId(d.id);
    setSelectedIdx(0);
    setShowDrafts(false);
    setMsg(`?? Loaded "${d.title}"`);
    setTimeout(() => setMsg(""), 2500);
  }

  async function hostNow() {
    let user = getOrCreateUser();
    if (!user) user = { playerId: randomUUID(), username: "", avatarSeed: "" };
    if (!user.username || !user.username.trim()) {
      const fallbackName = `Doodler-${Math.floor(100 + Math.random() * 900)}`;
      user.username = fallbackName;
      saveUser(user);
      setMsg(`ℹ️ Auto-assigned username: ${fallbackName}`);
    }
    try {
      const mappedQuestions = questions.map(item => {
        const elements = item.elements || [];
        const targetZones = elements
          .filter(el => el.type === "PRECISION_TARGET")
          .map(el => ({ xRatio: el.x_ratio, yRatio: el.y_ratio, wRatio: el.w_ratio, hRatio: el.h_ratio }));
        const allTargets = targetZones; // Rectangular correct zones validate via targetZones (freeform zones validate via point-in-polygon)
        const movableBlocks = elements
          .filter(el => el.type === "ANSWER_BLOCK")
          .map(el => ({ id: el.id, text: el.content ?? "", xRatio: el.x_ratio, yRatio: el.y_ratio, canMoveByPlayers: el.isMovableByPlayer ?? true }));
        const gaugeEl = elements.find(el => el.type === "GAUGE_BLOCK");
        const gauge = gaugeEl
          ? { enabled: true, min: gaugeEl.min, max: gaugeEl.max, correctMin: gaugeEl.correctMin, correctMax: gaugeEl.correctMax }
          : { enabled: false, min: 0, max: 100, correctMin: 0, correctMax: 100 };
        return {
          id: item.id,
          prompt: item.prompt?.trim() || `Question ${questions.indexOf(item) + 1}`,
          canvasImage: item.canvasImage ?? "",
          canvasImageFit: item.canvasImageFit ?? "contain",
          zoomScale: item.zoomScale ?? 1,
          panOffset: item.panOffset ?? { x: 0, y: 0 },
          elements: elements,
          targetZones: allTargets,
          movableBlocks,
          gauge,
        };
      });
      const res = await hostRoom({
        hostPlayerId: user.playerId,
        hostUsername: user.username,
        roundDurationSec,
        quiz: { title, questions: mappedQuestions },
      });
      saveRoomState(res.roomCode, { hostSecret: res.hostSecret, joinedAt: Date.now() });
      setMsg(`?? Hosted! Code: ${res.roomCode}`);
      router.push(`/room/${res.roomCode}`);
    } catch (err) {
      setMsg(`? Host failed: ${err.message}`);
    }
  }

  // -- Element type labels -------------------------------------------------------
  function elemBadge(type) {
    return type === "PRECISION_TARGET" ? "⏹️ Rect Zone"
      : type === "TEXT_BLOCK"         ? "📝 Text"
      : type === "ANSWER_BLOCK"       ? "📦 Answer"
      : type === "GAUGE_BLOCK"        ? "📊 Gauge"
      : type === "FREEFORM_ZONE"      ? "🔷 Poly Zone"
      : type === "IMAGE_BLOCK"        ? "🖼️ Image"
      : type === "DRAWING_STROKE"     ? "🖌️ Stroke"
      : type;
  }

  return (
    <div style={{
      height: "100dvh", display: "flex", flexDirection: "column",
      overflow: "hidden", fontFamily: "Patrick Hand, cursive", color: "#2f2a3c",
      background: "radial-gradient(circle at 20% 10%,rgba(255,214,186,.6),transparent 35%),radial-gradient(circle at 80% 0%,rgba(200,230,255,.8),transparent 42%),linear-gradient(140deg,#fffdf6,#f8fffd 55%,#fff2f5)",
    }}>

      {/* -- HEADER -- */}
      <header style={{
        display: "flex", alignItems: "center", gap: 8, flexShrink: 0,
        padding: "8px 16px", borderBottom: "3px solid #2f2a3c",
        background: "#fffaf0", flexWrap: "wrap",
      }}>
        <span style={{ fontFamily: "Short Stack, cursive", fontSize: "1.1rem", fontWeight: "bold", whiteSpace: "nowrap" }}>
          ✏️ Quiz Creator
        </span>
        <span style={{ flex: 1 }} />
        {msg && (
          <span style={{ background: "#ffd7ba", border: "2px solid #2f2a3c", borderRadius: 10, padding: "3px 10px", fontSize: "0.82rem", whiteSpace: "nowrap" }}>
            {msg}
          </span>
        )}
        <Link href="/" className="btn secondary" style={{ padding: "6px 12px", fontSize: "0.85rem" }}>← Back</Link>
        <button type="button" className="btn" style={{ padding: "6px 12px", fontSize: "0.85rem" }} onClick={saveToDraft}>💾 Save</button>

        {/* Drafts dropdown */}
        <div style={{ position: "relative" }}>
          {showDrafts && <div onClick={() => setShowDrafts(false)} style={{ position: "fixed", inset: 0, zIndex: 998 }} />}
          <button type="button" className="btn secondary" style={{ padding: "6px 12px", fontSize: "0.85rem", position: "relative", zIndex: 999 }} onClick={openDrafts}>
            📂 Drafts{savedDrafts.length > 0 && ` (${savedDrafts.length})`}
          </button>
          {showDrafts && (
            <div style={{
              position: "absolute", top: "calc(100% + 4px)", right: 0, zIndex: 999,
              background: "#fffaf0", border: "3px solid #2f2a3c", borderRadius: 14,
              padding: 8, minWidth: 260, maxHeight: 320, overflowY: "auto",
              boxShadow: "4px 4px 0 #0000002a",
            }}>
              {savedDrafts.length === 0 ? (
                <p style={{ margin: 0, fontSize: "0.85rem", opacity: 0.6, padding: 4 }}>No saved drafts yet. Click 💾 Save to create one.</p>
              ) : savedDrafts.map(d => (
                <div key={d.id} style={{ display: "flex", gap: 6, alignItems: "center", padding: "6px 4px", borderBottom: "1px solid #e5e0d8" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: "0.88rem", fontWeight: "bold", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.title}</div>
                    <div style={{ fontSize: "0.7rem", opacity: 0.5 }}>{new Date(d.createdAt).toLocaleString()} · {d.questions?.length ?? 0}Q</div>
                  </div>
                  <button type="button" className="btn" style={{ padding: "3px 10px", fontSize: "0.78rem", flexShrink: 0 }} onClick={() => loadDraft(d)}>Load</button>
                </div>
              ))}
            </div>
          )}
        </div>

        <button type="button" className="btn warn" style={{ padding: "6px 12px", fontSize: "0.85rem" }} onClick={hostNow}>🚀 Host</button>
      </header>

      {/* ── BODY ── */}
      <div style={{ display: "flex", flex: 1, minHeight: 0, overflow: "hidden" }}>

        {/* ── LEFT PANEL ── */}
        <aside style={{
          width: 292, flexShrink: 0, overflowY: "auto", overflowX: "hidden",
          borderRight: "3px solid #2f2a3c", background: "#fffaf0",
          display: "flex", flexDirection: "column",
        }}>

          {/* Quiz Settings */}
          <section style={{ padding: "10px 12px", borderBottom: "2px solid #e5e0d8" }}>
            <div style={{ fontSize: "0.72rem", fontWeight: "bold", opacity: 0.5, marginBottom: 6, letterSpacing: "0.06em" }}>⚙️ QUIZ SETTINGS</div>
            <input className="input" placeholder="Quiz title" value={title} onChange={e => setTitle(e.target.value)}
              style={{ marginBottom: 6, padding: "6px 10px", fontSize: "0.9rem" }} />
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span style={{ fontSize: "0.82rem", opacity: 0.7, whiteSpace: "nowrap" }}>Duration</span>
              <input className="input" type="number" min={5} max={180} value={roundDurationSec}
                onChange={e => setRoundDurationSec(Number(e.target.value))}
                style={{ width: 64, padding: "5px 8px", fontSize: "0.88rem" }} />
              <span style={{ fontSize: "0.82rem", opacity: 0.7 }}>s</span>
            </div>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 8 }}>
              {QUICK_TEMPLATES.map(t => (
                <button key={t.id} type="button" className="btn" style={{ padding: "2px 8px", fontSize: "0.75rem" }} onClick={() => loadTemplate(t)}>
                  {t.title}
                </button>
              ))}
            </div>
          </section>

          {/* Questions */}
          <section style={{ padding: "10px 12px", borderBottom: "2px solid #e5e0d8" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <span style={{ fontSize: "0.72rem", fontWeight: "bold", opacity: 0.5, letterSpacing: "0.06em" }}>📋 QUESTIONS ({questions.length})</span>
              <button type="button" className="btn" style={{ padding: "2px 8px", fontSize: "0.75rem" }} onClick={addQuestion}>+ Add</button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {questions.map((item, idx) => (
                <div key={item.id}
                  style={{ display: "flex", alignItems: "center", gap: 5, padding: "5px 8px", cursor: "pointer",
                    background: idx === selectedIdx ? "#c6f7e2" : "#fff",
                    border: "2px solid #2f2a3c", borderRadius: 10, fontSize: "0.85rem" }}
                  onClick={() => setSelectedIdx(idx)}
                >
                  <strong>Q{idx + 1}</strong>
                  <span style={{ flex: 1, opacity: 0.6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "0.8rem" }}>
                    {item.prompt ? item.prompt.slice(0, 26) + (item.prompt.length > 26 ? "…" : "") : "(no prompt)"}
                  </span>
                  <span style={{ fontSize: "0.68rem", opacity: 0.45, whiteSpace: "nowrap" }}>{item.elements.length}el</span>
                  {questions.length > 1 && (
                    <button type="button" className="btn danger" style={{ padding: "1px 5px", fontSize: "0.72rem" }}
                      onClick={e => { e.stopPropagation(); removeQuestion(idx); }}>×</button>
                  )}
                </div>
              ))}
            </div>
          </section>

          {/* Tools palette */}
          <section style={{ padding: "10px 12px", borderBottom: "2px solid #e5e0d8" }}>
            <div style={{ fontSize: "0.72rem", fontWeight: "bold", opacity: 0.5, marginBottom: 6, letterSpacing: "0.06em" }}>🧱 TOOLS</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 4 }}>
              {[...BLOCK_PALETTE, { mode: "__gauge__", icon: "📊", label: "Gauge", color: "#f3f4f6", description: "Add numerical slider trap" }].map(item => {
                const isActive = item.mode === "draw-target"
                  ? (canvasMode === "draw-target" || canvasMode === "draw-freeform")
                  : canvasMode === item.mode;
                return (
                  <button key={item.mode} type="button" title={item.description}
                    onClick={() => {
                      if (item.mode === "__gauge__") {
                        addGaugeBlock();
                      } else if (item.mode === "draw-target") {
                        setCanvasMode(zoneDrawType === "rectangle" ? "draw-target" : "draw-freeform");
                      } else {
                        setCanvasMode(item.mode);
                      }
                    }}
                    style={{
                      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 1,
                      padding: "6px 2px", minHeight: 52,
                      border: `2px solid ${isActive ? "#2f2a3c" : "#ddd"}`,
                      borderRadius: 10, background: isActive ? item.color : "#fff",
                      cursor: "pointer", fontFamily: "Patrick Hand, cursive",
                      fontSize: "0.68rem", lineHeight: 1.2,
                      boxShadow: isActive ? "0 2px 4px rgba(0,0,0,0.1)" : "none",
                      transition: "all 0.1s",
                    }}
                  >
                    <span style={{ fontSize: "1.25rem" }}>{item.icon}</span>
                    <span style={{ textAlign: "center" }}>{item.label.split(" /")[0].split(" (")[0]}</span>
                    {isActive && <span style={{ fontSize: "0.55rem", color: "#065f46" }}>●</span>}
                  </button>
                );
              })}
            </div>

            {/* Zone Shape Sub-options */}
            {(canvasMode === "draw-target" || canvasMode === "draw-freeform") && (
              <div style={{
                marginTop: 8, padding: 10, background: "#d1fae5", borderRadius: 12,
                border: "2px solid #2f2a3c", display: "flex", flexDirection: "column", gap: 6
              }}>
                <span style={{ fontSize: "0.85rem", fontWeight: "bold", fontFamily: "Short Stack, cursive" }}>
                  ✍️ Zone Drawing Mode:
                </span>
                <div style={{ display: "flex", gap: 6 }}>
                  <button type="button" className={`btn ${canvasMode === "draw-freeform" ? "" : "secondary"}`}
                    style={{ flex: 1, padding: "6px 8px", fontSize: "0.82rem", display: "flex", alignItems: "center", justifyContent: "center", gap: 4 }}
                    onClick={() => { setZoneDrawType("freeform"); setCanvasMode("draw-freeform"); }}>
                    🔷 Freeform
                  </button>
                  <button type="button" className={`btn ${canvasMode === "draw-target" ? "" : "secondary"}`}
                    style={{ flex: 1, padding: "6px 8px", fontSize: "0.82rem", display: "flex", alignItems: "center", justifyContent: "center", gap: 4 }}
                    onClick={() => { setZoneDrawType("rectangle"); setCanvasMode("draw-target"); }}>
                    ⏹️ Rectangle
                  </button>
                </div>
              </div>
            )}

            {canvasMode === "draw-brush" && (
              <div style={{ marginTop: 8, padding: 8, background: "#fce7f3", borderRadius: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={{ fontSize: "0.82rem", fontWeight: "bold" }}>Brush Mode:</span>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button type="button" className={`btn ${brushMode === "normal" ? "" : "secondary"}`}
                      style={{ flex: 1, padding: "4px 8px", fontSize: "0.82rem" }}
                      onClick={() => setBrushMode("normal")}>
                      ✏️ Line
                    </button>
                    <button type="button" className={`btn ${brushMode === "fill" ? "" : "secondary"}`}
                      style={{ flex: 1, padding: "4px 8px", fontSize: "0.82rem" }}
                      onClick={() => setBrushMode("fill")}>
                      🎨 Fill
                    </button>
                  </div>
                </div>
                <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: "0.82rem", marginTop: 4 }}>
                  Color
                  <input type="color" value={brushColor} onChange={e => setBrushColor(e.target.value)}
                    style={{ width: 30, height: 22, border: "none", borderRadius: 4, cursor: "pointer", padding: 0 }} />
                  <span style={{ fontFamily: "monospace", fontSize: "0.72rem", opacity: 0.7 }}>{brushColor}</span>
                </label>
                <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: "0.82rem" }}>
                  Size
                  <input type="range" min={1} max={40} value={brushWidth} onChange={e => setBrushWidth(Number(e.target.value))}
                    style={{ flex: 1, accentColor: brushColor }} />
                  <span style={{ fontSize: "0.78rem", minWidth: 26 }}>{brushWidth}px</span>
                </label>
              </div>
            )}

            <div style={{ marginTop: 8, padding: "5px 8px", background: "#f0f9ff", borderRadius: 8, fontSize: "0.73rem", opacity: 0.8 }}>
              📋 Click canvas → <kbd>Ctrl+V</kbd> to paste image / text
            </div>
          </section>

          {/* Q Properties */}
          {q && (
            <section style={{ padding: "10px 12px", borderBottom: "2px solid #e5e0d8" }}>
              <div style={{ fontSize: "0.72rem", fontWeight: "bold", opacity: 0.5, marginBottom: 6, letterSpacing: "0.06em" }}>
                📐 Q{selectedIdx + 1} PROPERTIES
              </div>
              <label style={{ fontSize: "0.82rem", display: "block" }}>
                <span style={{ opacity: 0.7 }}>Prompt</span>
                <textarea value={q.prompt || ""} onChange={e => updateQ({ prompt: e.target.value })}
                  style={{ minHeight: 52, fontSize: "0.85rem", padding: "6px 8px" }} />
              </label>
              <div style={{ display: "flex", gap: 6, marginTop: 6, alignItems: "flex-end" }}>
                <label style={{ fontSize: "0.82rem", flex: 1 }}>
                  <span style={{ opacity: 0.7 }}>Background image</span>
                  <input type="file" accept="image/*" onChange={onImageUpload} style={{ display: "block", fontSize: "0.75rem", marginTop: 3 }} />
                  {q.canvasImage && (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                      <small style={{ color: "#065f46" }}>Image loaded ✓</small>
                      <button type="button" className="btn danger" style={{ padding: "2px 6px", fontSize: "0.7rem", lineHeight: 1 }}
                        onClick={() => updateQ({ canvasImage: "" })}>
                        Remove
                      </button>
                    </div>
                  )}
                </label>
                {q.canvasImage && (
                  <label style={{ fontSize: "0.82rem", width: 90 }}>
                    <span style={{ opacity: 0.7 }}>Fit Mode</span>
                    <select className="input" value={q.canvasImageFit ?? "contain"}
                      onChange={e => updateQ({ canvasImageFit: e.target.value })}
                      style={{ padding: "5px 7px", fontSize: "0.85rem", marginTop: 3 }}>
                      <option value="contain">Contain</option>
                      <option value="cover">Cover (Crop)</option>
                    </select>
                  </label>
                )}
                <label style={{ fontSize: "0.82rem", width: 80 }}>
                  <span style={{ opacity: 0.7 }}>Zoom</span>
                  <input className="input" type="number" step={0.05} min={0.05} max={8} value={q.zoomScale}
                    onChange={e => updateQ({ zoomScale: parseFloat(e.target.value) || 1 })}
                    style={{ padding: "5px 7px", fontSize: "0.85rem" }} />
                </label>
              </div>
            </section>
          )}

          {/* Elements list */}
          {q && (
            <section style={{ padding: "10px 12px", flex: 1 }}>
              <div style={{ fontSize: "0.72rem", fontWeight: "bold", opacity: 0.5, marginBottom: 6, letterSpacing: "0.06em" }}>
                📦 ELEMENTS ({q.elements.length})
              </div>
              {q.elements.length === 0 ? (
                <small style={{ opacity: 0.5 }}>No elements yet. Use the Tools above.</small>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {q.elements.map((el, idx) => (
                    <div key={el.id} className="card" style={{ padding: "6px 8px", display: "grid", gap: 5, borderWidth: 2 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                        <span className="badge" style={{ fontSize: "0.68rem", margin: 0, padding: "2px 7px" }}>{elemBadge(el.type)}</span>
                        <span style={{ flex: 1, fontSize: "0.72rem", opacity: 0.55, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {el.type === "PRECISION_TARGET"
                            ? `${Math.round(el.x_ratio*100)}%,${Math.round(el.y_ratio*100)}% · ${Math.round(el.w_ratio*100)}×${Math.round(el.h_ratio*100)}%`
                            : el.type === "FREEFORM_ZONE"   ? `${el.points_ratio?.length ?? 0} pts`
                            : el.type === "IMAGE_BLOCK"     ? `${Math.round(el.w_ratio*100)}×${Math.round(el.h_ratio*100)}%`
                            : el.type === "DRAWING_STROKE"  ? `${el.points_ratio?.length ?? 0} pts`
                            : el.type === "GAUGE_BLOCK"     ? `${el.min}–${el.max}`
                            : `"${(el.content ?? "").slice(0, 20)}"`}
                        </span>
                        <button type="button" className="btn secondary" style={{ padding: "1px 6px", fontSize: "0.72rem", lineHeight: 1 }}
                          disabled={idx === q.elements.length - 1} title="Layer Up (Bring to Front)"
                          onClick={() => layerUpElement(idx)}>▲</button>
                        <button type="button" className="btn secondary" style={{ padding: "1px 6px", fontSize: "0.72rem", lineHeight: 1 }}
                          disabled={idx === 0} title="Layer Down (Send to Back)"
                          onClick={() => layerDownElement(idx)}>▼</button>
                        <button type="button" className="btn danger" style={{ padding: "1px 6px", fontSize: "0.75rem" }}
                          onClick={() => removeElement(el.id)}>×</button>
                      </div>

                      {(el.type === "TEXT_BLOCK" || el.type === "ANSWER_BLOCK") && (
                        <>
                          {editingElemId === el.id ? (
                            <input className="input" value={el.content}
                              onChange={e => patchElement(el.id, { content: e.target.value })}
                              onBlur={() => setEditingElemId(null)} autoFocus
                              style={{ padding: "5px 8px", fontSize: "0.85rem" }} />
                          ) : (
                            <button type="button" onClick={() => setEditingElemId(el.id)}
                              style={{ background: "none", border: "1px dashed #ccc", borderRadius: 8, padding: "3px 7px", cursor: "pointer", textAlign: "left", fontFamily: "inherit", fontSize: "0.82rem" }}>
                              {el.content || "(empty)"} <small style={{ opacity: 0.4 }}>✏️</small>
                            </button>
                          )}
                          <label style={{ display: "flex", gap: 5, alignItems: "center", fontSize: "0.78rem" }}>
                            <input type="checkbox" checked={el.isMovableByPlayer ?? false}
                              onChange={e => patchElement(el.id, { isMovableByPlayer: e.target.checked })} />
                            <span style={{ opacity: 0.7 }}>Movable by player</span>
                          </label>
                          <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 4 }}>
                            <span style={{ fontSize: "0.78rem", opacity: 0.7 }}>Block Color:</span>
                            <input type="color" value={el.color ?? (el.type === "ANSWER_BLOCK" ? "#c8e6ff" : "#ffd7ba")}
                              onChange={e => patchElement(el.id, { color: e.target.value })}
                              style={{ width: 28, height: 22, border: "none", padding: 0, cursor: "pointer", borderRadius: 4 }} />
                            <button type="button" className="btn" style={{ padding: "2px 6px", fontSize: "0.7rem", lineHeight: 1 }}
                              onClick={() => patchElement(el.id, { color: undefined })}>Reset</button>
                          </div>
                        </>
                      )}

                      {el.type === "DRAWING_STROKE" && (
                        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                          <input type="color" value={el.color ?? "#2f2a3c"}
                            onChange={e => patchElement(el.id, { color: e.target.value })}
                            style={{ width: 28, height: 22, border: "none", padding: 0, cursor: "pointer" }} />
                          <input type="number" min={1} max={40} className="input"
                            style={{ width: 50, padding: "3px 6px", fontSize: "0.82rem" }}
                            value={el.strokeWidth ?? 3}
                            onChange={e => patchElement(el.id, { strokeWidth: Number(e.target.value) })} />
                          <span style={{ fontSize: "0.78rem", opacity: 0.6 }}>px</span>
                        </div>
                      )}

                      {el.type === "IMAGE_BLOCK" && (
                        <div style={{ display: "flex", gap: 6 }}>
                          {[["W%","w_ratio"],["H%","h_ratio"]].map(([lbl,key]) => (
                            <label key={key} style={{ fontSize: "0.78rem", display: "flex", gap: 3, alignItems: "center" }}>
                              {lbl}
                              <input className="input" type="number" min={2} max={100}
                                style={{ width: 52, padding: "3px 6px", fontSize: "0.82rem" }}
                                value={Math.round(el[key] * 100)}
                                onChange={e => patchElement(el.id, { [key]: Math.max(0.02, Math.min(1, Number(e.target.value)/100)) })} />
                            </label>
                          ))}
                        </div>
                      )}

                      {el.type === "GAUGE_BLOCK" && (
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
                          {[["Min","min",el.min],["Max","max",el.max],["✅Min","correctMin",el.correctMin],["✅Max","correctMax",el.correctMax]].map(([lbl,key,val]) => (
                            <label key={key} style={{ fontSize: "0.75rem" }}>
                              {lbl}
                              <input className="input" type="number" value={val}
                                style={{ padding: "3px 6px", fontSize: "0.82rem" }}
                                onChange={e => patchElement(el.id, { [key]: Number(e.target.value) })} />
                            </label>
                          ))}
                        </div>
                      )}

                      {el.type === "FREEFORM_ZONE" && (
                        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                          <small style={{ opacity: 0.55, fontSize: "0.75rem" }}>{el.points_ratio?.length ?? 0} pts</small>
                          <button type="button"
                            onClick={() => patchElement(el.id, { role: el.role === "DECOY" ? "CORRECT_ANSWER" : "DECOY" })}
                            style={{ padding: "2px 10px", borderRadius: 8, cursor: "pointer", border: "2px solid",
                              borderColor: el.role === "DECOY" ? "#ef4444" : "#22c55e",
                              background: el.role === "DECOY" ? "#fee2e2" : "#dcfce7",
                              fontFamily: "Patrick Hand, cursive", fontSize: "0.78rem" }}>
                            {el.role === "DECOY" ? "🪤 DECOY" : "✅ CORRECT"}
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
        </aside>

        {/* ── RIGHT PANEL: Canvas ── */}
        <section style={{
          flex: 1, minWidth: 0, display: "flex", flexDirection: "column",
          padding: "10px 12px", gap: 8, overflowY: "auto",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            <span style={{ fontSize: "0.9rem", fontWeight: "bold" }}>🖼️ Canvas Editor</span>
            <span style={{ fontSize: "0.78rem", opacity: 0.55 }}>
              Active: {
                canvasMode === "draw-freeform" ? "🔷" : 
                canvasMode === "draw-target" ? "⏹️" : 
                BLOCK_PALETTE.find(p => p.mode === canvasMode)?.icon
              }{" "}
              <strong>
                {canvasMode === "draw-freeform" ? "Zone (Freeform)" : 
                 canvasMode === "draw-target" ? "Zone (Rectangle)" : 
                 (BLOCK_PALETTE.find(p => p.mode === canvasMode)?.label ?? canvasMode)}
              </strong>
              {canvasMode === "draw-target"   && " — Drag to draw rectangular target"}
              {canvasMode === "draw-freeform" && " — Hold & drag to draw freeform polygon"}
              {canvasMode === "draw-brush"    && " — Hold & drag to paint"}
              {canvasMode === "place-text"    && " — Click to drop Text Block"}
              {canvasMode === "place-answer"  && " — Click to drop Answer Block"}
            </span>
          </div>

          {q && (
            <div style={{ padding: "6px 12px", background: "#fef3c7", border: "2px solid #2f2a3c", borderRadius: 12, display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
              <span style={{ fontSize: "1.1rem" }}>❓</span>
              <strong style={{ fontSize: "0.95rem", fontFamily: "Patrick Hand, cursive" }}>Question Prompt:</strong>
              <span style={{ fontSize: "0.95rem", fontFamily: "Patrick Hand, cursive" }}>{q.prompt || "(no prompt set yet - edit in sidebar)"}</span>
            </div>
          )}

          {q && (
            <DoodleCanvas
              key={q.id}
              question={q}
              disabled={false}
              isCreator={true}
              creatorMode={canvasMode}
              brushColor={brushColor}
              brushWidth={brushWidth}
              brushMode={brushMode}
              defaultZoneRole={defaultZoneRole}
              onElementsChange={elements => updateQ({ elements })}
              onZoomPanChange={({ zoomScale, panOffset }) => updateQ({ zoomScale, panOffset })}
            />
          )}

          <details className="card" style={{ padding: "8px 12px", fontSize: "0.8rem", flexShrink: 0 }}>
            <summary style={{ cursor: "pointer", fontWeight: "bold", userSelect: "none" }}>ℹ️ How it works</summary>
            <ul style={{ margin: "6px 0 0", paddingLeft: 18, lineHeight: 1.7, opacity: 0.7 }}>
              <li>Target zones (🎯 ✏️) are <strong>invisible to players</strong> — this is the trap.</li>
              <li>Drop an <strong>Answer Block</strong> on top — players drag it away to reveal.</li>
              <li>Set zoom ≤ 0.4 for "Microscopic Quest" needle-in-a-haystack style.</li>
              <li>Add a <strong>Gauge Slider</strong> to require a number + click combination.</li>
            </ul>
          </details>
        </section>

      </div>
    </div>
  );
}
