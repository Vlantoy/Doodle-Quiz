"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import rough from "roughjs";

function randomUUID() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
  });
}


/**
 * INFINITE INTERACTIVE CANVAS ENGINE
 *
 * Data model (question.elements):
 *   TEXT_BLOCK       – static label, never moved by players
 *   ANSWER_BLOCK     – text block, optionally movable by players (isMovableByPlayer)
 *   PRECISION_TARGET – invisible hit zone; hidden during gameplay (isHidden: true)
 *   GAUGE_BLOCK      – numerical slider trap { min, max, correctMin, correctMax }
 *
 * Coordinates: all x_ratio, y_ratio, w_ratio, h_ratio ∈ [0,1] relative to canvas box.
 *
 * Zoom/Pan — Two-Layer Coordinate Mapping (spec §4):
 *   Rendering:    translate(panOffset.x, panOffset.y) scale(zoomScale)
 *   Hit-detect:   canvasX = (screenX - containerLeft - panOffset.x) / (containerWidth * zoomScale)
 */

const DRAG_THRESHOLD = 6;
const C_W = 500;
const C_H = 500;

/**
 * Ray-casting (Jordan curve) point-in-polygon test.
 * Safe against horizontal edges: the (yi > ry) !== (yj > ry) guard prevents
 * division by zero when yj === yi.
 * @param {number} rx  x-ratio [0,1] in canvas space
 * @param {number} ry  y-ratio [0,1] in canvas space
 * @param {{ x: number, y: number }[]} points  polygon vertices as ratios
 */
function pointInPolygon(rx, ry, points) {
  let inside = false;
  const n = points.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = points[i].x, yi = points[i].y;
    const xj = points[j].x, yj = points[j].y;
    if (((yi > ry) !== (yj > ry)) && (rx < ((xj - xi) * (ry - yi)) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

// ── Resize-handle constants ────────────────────────────────────────────────
const HANDLES = ["nw","n","ne","e","se","s","sw","w"];
const HANDLE_CURSOR = {
  nw:"nwse-resize", ne:"nesw-resize", sw:"nesw-resize", se:"nwse-resize",
  n:"ns-resize",    s:"ns-resize",    e:"ew-resize",    w:"ew-resize",
};
const HANDLE_POS = {
  nw: { top: -5,  left: -5  },
  n:  { top: -5,  left: "calc(50% - 5px)" },
  ne: { top: -5,  right: -5 },
  e:  { top: "calc(50% - 5px)", right: -5 },
  se: { bottom: -5, right: -5 },
  s:  { bottom: -5, left: "calc(50% - 5px)" },
  sw: { bottom: -5, left: -5 },
  w:  { top: "calc(50% - 5px)", left: -5 },
};
function ResizeHandles({ onHandleDown, active }) {
  return HANDLES.map(h => (
    <div key={h} style={{
      position:"absolute", width:10, height:10,
      background: active ? "#3b82f6" : "#94a3b8",
      border:"2px solid #fff",
      borderRadius:2, zIndex:10, touchAction:"none",
      opacity: active ? 1 : 0.55,
      cursor: HANDLE_CURSOR[h], ...HANDLE_POS[h],
    }} onPointerDown={e => { e.stopPropagation(); onHandleDown(e, h); }} />
  ));
}

// Helper to compute star points in a rect
function getStarPoints(x, y, w, h) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const spikes = 5;
  const outerRadius = Math.min(w, h) / 2;
  const innerRadius = outerRadius * 0.4;
  const rot = Math.PI / 2 * 3;
  let angle = rot;
  const step = Math.PI / spikes;
  const pts = [];
  for (let i = 0; i < spikes * 2; i++) {
    const r = (i % 2 === 0) ? outerRadius : innerRadius;
    pts.push([
      cx + Math.cos(angle) * r,
      cy + Math.sin(angle) * r
    ]);
    angle += step;
  }
  return pts;
}

// Helper to compute heart points in a rect
function getHeartPoints(bx, by, bw, bh) {
  const pts = [];
  const steps = 40;
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const x_raw = 16 * Math.pow(Math.sin(t), 3);
    const y_raw = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
    const x_norm = (x_raw + 16) / 32;
    const y_norm = (y_raw + 12) / 29;
    pts.push([
      bx + x_norm * bw,
      by + y_norm * bh
    ]);
  }
  return pts;
}

function renderShapeHelper(svg, rc, shapeType, x, y, w, h, stroke, strokeWidth, fill, fillStyle) {
  if (shapeType === "rect") {
    svg.appendChild(rc.rectangle(x, y, w, h, {
      roughness: 1.5, stroke, strokeWidth, fill, fillStyle,
    }));
  } else if (shapeType === "circle") {
    svg.appendChild(rc.ellipse(x + w / 2, y + h / 2, w, h, {
      roughness: 1.5, stroke, strokeWidth, fill, fillStyle,
    }));
  } else if (shapeType === "triangle" || shapeType === "triangle-iso") {
    const p1 = [x + w / 2, y];
    const p2 = [x, y + h];
    const p3 = [x + w, y + h];
    svg.appendChild(rc.polygon([p1, p2, p3], {
      roughness: 1.5, stroke, strokeWidth, fill, fillStyle,
    }));
  } else if (shapeType === "triangle-right") {
    const p1 = [x, y];
    const p2 = [x, y + h];
    const p3 = [x + w, y + h];
    svg.appendChild(rc.polygon([p1, p2, p3], {
      roughness: 1.5, stroke, strokeWidth, fill, fillStyle,
    }));
  } else if (shapeType === "star") {
    const pts = getStarPoints(x, y, w, h);
    svg.appendChild(rc.polygon(pts, {
      roughness: 1.5, stroke, strokeWidth, fill, fillStyle,
    }));
  } else if (shapeType === "diamond") {
    const p1 = [x + w / 2, y];
    const p2 = [x + w, y + h / 2];
    const p3 = [x + w / 2, y + h];
    const p4 = [x, y + h / 2];
    svg.appendChild(rc.polygon([p1, p2, p3, p4], {
      roughness: 1.5, stroke, strokeWidth, fill, fillStyle,
    }));
  } else if (shapeType === "arrow") {
    const p1 = [x, y + h * 0.35];
    const p2 = [x + w * 0.6, y + h * 0.35];
    const p3 = [x + w * 0.6, y + h * 0.15];
    const p4 = [x + w, y + h * 0.5];
    const p5 = [x + w * 0.6, y + h * 0.85];
    const p6 = [x + w * 0.6, y + h * 0.65];
    const p7 = [x, y + h * 0.65];
    svg.appendChild(rc.polygon([p1, p2, p3, p4, p5, p6, p7], {
      roughness: 1.5, stroke, strokeWidth, fill, fillStyle,
    }));
  } else if (shapeType === "heart") {
    const pts = getHeartPoints(x, y, w, h);
    svg.appendChild(rc.polygon(pts, {
      roughness: 1.5, stroke, strokeWidth, fill, fillStyle,
    }));
  }
}

// Compute axis-aligned bounding box from points_ratio array
function computeBBox(pts) {
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const bx = Math.min(...xs), by = Math.min(...ys);
  return { bx, by, bw: Math.max(...xs) - bx, bh: Math.max(...ys) - by };
}
// Scale all points proportionally into a new bounding box
function resizePoints(pts, old, next) {
  return pts.map(p => ({
    x: old.bw > 0 ? next.bx + (p.x - old.bx) / old.bw * next.bw : p.x,
    y: old.bh > 0 ? next.by + (p.y - old.by) / old.bh * next.bh : p.y,
  }));
}

function HandDrawnBackground({ canvasWidth, elColor, isAnswer, isMovable, isSelected }) {
  const svgRef = useRef(null);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    svg.innerHTML = "";

    const parent = svg.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    const w = rect.width || 100;
    const h = rect.height || 50;

    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);

    const rc = rough.svg(svg);
    const strokeColor = isSelected ? "#3b82f6" : (isAnswer ? "#7c3aed" : "#2f2a3c");
    const fillColor = elColor || (isAnswer ? (isMovable ? "#c8e6ff" : "#ddd6fe") : "#ffd7ba");

    const node = rc.rectangle(2.5, 2.5, w - 5, h - 5, {
      roughness: 1.5,
      stroke: strokeColor,
      strokeWidth: isSelected ? 3.5 : 2.5,
      fill: fillColor,
      fillStyle: "solid",
    });

    svg.appendChild(node);
  }, [canvasWidth, elColor, isAnswer, isMovable, isSelected]);

  return (
    <svg
      ref={svgRef}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: 1,
        overflow: "visible",
      }}
    />
  );
}

function getDecimalPlaces(num) {
  const str = String(num);
  const dotIdx = str.indexOf(".");
  return dotIdx === -1 ? 0 : str.length - dotIdx - 1;
}

function GaugeWidget({ el, isCreator, creatorMode, isSelected, canvasWidth, revealAnswers, onValueChange }) {
  const trackRef = useRef(null);
  const svgRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);
  const [size, setSize] = useState({ width: 200, height: 40 });

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const observer = new ResizeObserver((entries) => {
      for (let entry of entries) {
        setSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height
        });
      }
    });
    observer.observe(track);
    return () => observer.disconnect();
  }, []);

  const tickLabels = useMemo(() => {
    return el.labels
      ? el.labels.split(",").map(s => s.trim()).filter(Boolean)
      : [];
  }, [el.labels]);

  const minVal = tickLabels.length > 0 ? 0 : (el.min ?? 0);
  const maxVal = tickLabels.length > 0 ? tickLabels.length - 1 : (el.max ?? 100);
  const step = tickLabels.length > 0 ? 1 : (el.step ?? 1);

  let currentValue = el.currentValue;
  if (tickLabels.length > 0) {
    const valStr = String(currentValue ?? "");
    if (!tickLabels.includes(valStr)) {
      currentValue = tickLabels[0] || "";
    } else {
      currentValue = valStr;
    }
  } else {
    let parsed = Number(currentValue);
    if (isNaN(parsed) || !isFinite(parsed)) {
      parsed = Number(el.min ?? 0);
    }
    currentValue = parsed;
  }

  // Format the value to show trailing zeros corresponding to the step decimals input
  let displayValue = currentValue;
  if (tickLabels.length === 0 && typeof currentValue === "number") {
    const decimals = getDecimalPlaces(step);
    displayValue = currentValue.toFixed(decimals);
  }

  // Calculate handle position percentage
  let pct = 0;
  if (tickLabels.length > 0) {
    const idx = tickLabels.indexOf(String(currentValue));
    const safeIdx = idx === -1 ? 0 : idx;
    pct = tickLabels.length > 1 ? (safeIdx / (tickLabels.length - 1)) * 100 : 0;
  } else {
    const range = maxVal - minVal;
    pct = range > 0 ? ((currentValue - minVal) / range) * 100 : 0;
  }
  if (isNaN(pct) || !isFinite(pct)) pct = 0;
  pct = Math.max(0, Math.min(100, pct));

  // Calculate correct indicator position
  let showCorrect = isCreator || revealAnswers;
  let correctPct = 0;
  let correctPctEnd = 0;
  let correctValText = "";
  const correctMin = typeof el.correctMin === "number" ? el.correctMin : (Number(el.correctValue) || el.min || 0);
  const correctMax = typeof el.correctMax === "number" ? el.correctMax : (Number(el.correctValue) || el.max || 0);

  if (showCorrect) {
    if (tickLabels.length > 0) {
      const cVal = el.correctValue ?? tickLabels[0];
      correctValText = cVal;
      const idx = tickLabels.indexOf(String(cVal));
      const safeCorrectIdx = idx === -1 ? 0 : idx;
      correctPct = tickLabels.length > 1 ? (safeCorrectIdx / (tickLabels.length - 1)) * 100 : 0;
    } else {
      correctValText = correctMin === correctMax ? `${correctMin}` : `${correctMin}-${correctMax}`;
      const range = maxVal - minVal;
      if (range > 0) {
        correctPct = ((correctMin - minVal) / range) * 100;
        correctPctEnd = ((correctMax - minVal) / range) * 100;
      }
    }
  }
  if (isNaN(correctPct) || !isFinite(correctPct)) correctPct = 0;
  correctPct = Math.max(0, Math.min(100, correctPct));
  if (isNaN(correctPctEnd) || !isFinite(correctPctEnd)) correctPctEnd = 0;
  correctPctEnd = Math.max(0, Math.min(100, correctPctEnd));

  const handlePointerDown = (e) => {
    e.stopPropagation();
    if (isCreator && creatorMode !== "pan") return;
    
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsDragging(true);
    updateValue(e.clientX);
  };

  const handlePointerMove = (e) => {
    if (!isDragging) return;
    e.stopPropagation();
    updateValue(e.clientX);
  };

  const handlePointerUp = (e) => {
    if (!isDragging) return;
    e.stopPropagation();
    setIsDragging(false);
  };

  const formatMiddleVal = (val) => {
    const decimals = Math.max(getDecimalPlaces(minVal), getDecimalPlaces(maxVal), getDecimalPlaces(step), 2);
    return Number(Number(val).toFixed(decimals));
  };

  const updateValue = (clientX) => {
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));

    if (tickLabels.length > 0) {
      const idx = Math.round(frac * (tickLabels.length - 1));
      onValueChange(tickLabels[idx]);
    } else {
      let val = minVal + frac * (maxVal - minVal);
      val = Math.round(val / step) * step;
      // Round to precision to avoid floating point errors like 0.30000000004
      const decimals = getDecimalPlaces(step);
      val = Number(val.toFixed(decimals));
      val = Math.max(minVal, Math.min(maxVal, val));
      onValueChange(val);
    }
  };

  const activeColor = el.color || "#7c3aed";

  const ticks = useMemo(() => {
    const t = [];
    if (tickLabels.length > 0) {
      for (let i = 0; i < tickLabels.length; i++) {
        t.push({
          pct: tickLabels.length > 1 ? (i / (tickLabels.length - 1)) * 100 : 0,
          isMajor: true
        });
      }
    } else {
      for (let i = 0; i <= 20; i++) {
        t.push({
          pct: i * 5,
          isMajor: i % 2 === 0
        });
      }
    }
    return t;
  }, [tickLabels]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    svg.innerHTML = "";

    const { width: w, height: h } = size;
    if (w <= 0 || h <= 0) return;

    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    const rc = rough.svg(svg);

    const padding = 3.5;
    const rx = padding;
    const ry = padding;
    const rw = w - padding * 2;
    const rh = h - padding * 2;

    const strokeColor = "#2f2a3c";
    const fillColor = "#fcd34d"; // beautiful cartoon yellow wood color

    // Draw the main ruler background with roughjs
    const bgNode = rc.rectangle(rx, ry, rw, rh, {
      roughness: 1.2,
      stroke: strokeColor,
      strokeWidth: 3,
      fill: fillColor,
      fillStyle: "solid",
    });
    svg.appendChild(bgNode);

    // Soft organic wood grain or cartoon highlight lines
    const grainColor = "rgba(0, 0, 0, 0.08)";
    if (rw > 60) {
      const g1 = rc.line(rx + 15, ry + rh * 0.2, rx + 35, ry + rh * 0.2, { stroke: grainColor, strokeWidth: 2, roughness: 1.5 });
      const g2 = rc.line(rx + 10, ry + rh * 0.5, rx + 25, ry + rh * 0.5, { stroke: grainColor, strokeWidth: 2, roughness: 1.5 });
      const g3 = rc.line(rx + 18, ry + rh * 0.8, rx + 30, ry + rh * 0.8, { stroke: grainColor, strokeWidth: 2, roughness: 1.5 });
      svg.appendChild(g1);
      svg.appendChild(g2);
      svg.appendChild(g3);

      const g4 = rc.line(rx + rw - 35, ry + rh * 0.2, rx + rw - 15, ry + rh * 0.2, { stroke: grainColor, strokeWidth: 2, roughness: 1.5 });
      const g5 = rc.line(rx + rw - 25, ry + rh * 0.5, rx + rw - 10, ry + rh * 0.5, { stroke: grainColor, strokeWidth: 2, roughness: 1.5 });
      const g6 = rc.line(rx + rw - 30, ry + rh * 0.8, rx + rw - 18, ry + rh * 0.8, { stroke: grainColor, strokeWidth: 2, roughness: 1.5 });
      svg.appendChild(g4);
      svg.appendChild(g5);
      svg.appendChild(g6);
    }

    // Draw sketchy tick lines
    ticks.forEach((t) => {
      const x = rx + (t.pct / 100) * rw;
      const tickHeight = t.isMajor ? rh * 0.35 : rh * 0.2;
      const tickY1 = ry;
      const tickY2 = ry + tickHeight;

      const tickNode = rc.line(x, tickY1, x, tickY2, {
        stroke: strokeColor,
        strokeWidth: t.isMajor ? 2.5 : 1.5,
        roughness: 0.8,
      });
      svg.appendChild(tickNode);
    });

  }, [size, ticks]);

  return (
    <div style={{
      position: "relative",
      width: "100%",
      height: "100%",
      userSelect: "none",
      fontFamily: "Patrick Hand, cursive",
    }}>

      {/* Ruler Track Body Container */}
      <div 
        ref={trackRef}
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 2,
          overflow: "visible",
          background: "transparent",
        }}
      >
        {/* Dynamic hand-drawn SVG ruler layer */}
        <svg
          ref={svgRef}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            pointerEvents: "none",
            zIndex: 1,
            overflow: "visible",
            filter: "drop-shadow(3px 3px 0px rgba(0,0,0,0.12))"
          }}
        />

        {/* Target Answer Range Highlight (Correct Range) */}
        {showCorrect && !el.labels && correctMin !== correctMax && (
          <div style={{
            position: "absolute",
            left: `${correctPct}%`,
            width: `${Math.max(2, correctPctEnd - correctPct)}%`,
            top: 4,
            bottom: 4,
            background: "rgba(34, 197, 94, 0.22)",
            borderLeft: "2.5px dashed #15803d",
            borderRight: "2.5px dashed #15803d",
            boxSizing: "border-box",
            zIndex: 3,
            pointerEvents: "none"
          }} />
        )}

        {/* Target Answer Point Highlight (Correct Tick or Precise Number) */}
        {showCorrect && (el.labels || (!el.labels && correctMin === correctMax)) && (
          <div style={{
            position: "absolute",
            left: `${correctPct}%`,
            top: 4,
            bottom: 4,
            width: 4,
            background: "#22c55e",
            borderLeft: "1.5px solid #15803d",
            borderRight: "1.5px solid #15803d",
            transform: "translateX(-50%)",
            zIndex: 3,
            pointerEvents: "none"
          }} />
        )}

        {/* Drag Handle sitting on the top edge of the ruler */}
        <div 
          style={{
            position: "absolute",
            left: `${pct}%`,
            top: 0, 
            transform: "translate(-50%, -34px)", // align bottom of pointer pin with top of ruler
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            cursor: (isCreator && creatorMode !== "pan") ? "default" : "grab",
            zIndex: 10,
            touchAction: "none"
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        >
          <svg
            width="36"
            height="46"
            viewBox="0 0 36 46"
            style={{
              overflow: "visible",
              filter: "drop-shadow(2px 3px 0px rgba(0,0,0,0.15))"
            }}
          >
            {/* Main cartoon balloon pin shape */}
            <path
              d="M 18,2 C 26.8,2 34,9.2 34,18 C 34,24.5 30,28 26,30 L 18,42 L 10,30 C 6,28 2,24.5 2,18 C 2,9.2 9.2,2 18,2 Z"
              fill={activeColor}
              stroke="#2f2a3c"
              strokeWidth="3.5"
              strokeLinejoin="round"
            />
            {/* Glossy shine highlight */}
            <ellipse cx="12" cy="12" rx="4" ry="2" fill="white" opacity="0.6" transform="rotate(-30, 12, 12)" />
            {/* Center pin-hole decoration */}
            <circle cx="18" cy="18" r="3" fill="#2f2a3c" />
          </svg>
        </div>

        {/* Pop-up bubble showing current value (floats above the knob) */}
        <div style={{
          position: "absolute",
          left: `${pct}%`,
          bottom: "calc(100% + 40px)", // floats above the balloon pointer handle
          transform: "translateX(-50%)",
          background: activeColor,
          color: "#fff",
          padding: "5px 12px",
          borderRadius: "16px 12px 16px 10px / 12px 16px 10px 14px", // sketchy cartoon shape
          fontSize: `${Math.max(13, Math.min(19, canvasWidth * 0.02))}px`,
          fontWeight: "bold",
          border: "3px solid #2f2a3c",
          boxShadow: "3px 3px 0px rgba(0,0,0,0.15)",
          whiteSpace: "nowrap",
          zIndex: 15,
          pointerEvents: "none",
          display: "flex",
          flexDirection: "column",
          alignItems: "center"
        }}>
          {displayValue}
          {/* Tooltip pointer arrow pointing down */}
          <svg
            width="16"
            height="10"
            viewBox="0 0 16 10"
            style={{
              position: "absolute",
              top: "100%",
              left: "50%",
              transform: "translateX(-50%) translateY(-2px)",
              pointerEvents: "none",
            }}
          >
            {/* Arrow background with border */}
            <path d="M 0,0 L 8,8 L 16,0" fill={activeColor} stroke="#2f2a3c" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            {/* Mask line to cover the bubble bottom border */}
            <line x1="1.5" y1="0" x2="14.5" y2="0" stroke={activeColor} strokeWidth="4" />
          </svg>
        </div>
      </div>

      {/* Ticks / Values at the bottom of the ruler block */}
      <div style={{
        position: "absolute",
        top: "calc(100% + 4px)",
        left: 0,
        right: 0,
        display: "flex",
        justifyContent: "space-between",
        fontSize: `${Math.max(10, Math.min(16, canvasWidth * 0.018))}px`,
        fontWeight: "bold",
        opacity: 0.9,
        padding: "0 10px",
        boxSizing: "border-box",
        color: "#2f2a3c",
        textShadow: "1px 1px 0px #fff, -1px -1px 0px #fff, 1px -1px 0px #fff, -1px 1px 0px #fff", // white outline for readability
        pointerEvents: "none"
      }}>
        {tickLabels.length > 0 ? (
          <>
            <span>{tickLabels[0]}</span>
            {tickLabels.length > 2 && <span>{tickLabels[Math.floor(tickLabels.length / 2)]}</span>}
            <span>{tickLabels[tickLabels.length - 1]}</span>
          </>
        ) : (
          <>
            <span>{minVal}</span>
            <span>{formatMiddleVal((minVal + maxVal) / 2)}</span>
            <span>{maxVal}</span>
          </>
        )}
      </div>
    </div>
  );
}

/*
  Props:
    question         – slide data { id, prompt, canvasImage, zoomScale, panOffset, elements[] }
    disabled         – strip all interactivity
    onSolve          – ({rx, ry, gaugeValue, isLocalHit}) => void  fires on every player click; server re-validates
    isCreator        – show targets + enable draw/place editing modes
    creatorMode      – "pan" | "draw-target" | "draw-freeform" | "draw-brush" | "place-text" | "place-answer"
    onElementsChange – (elements[]) => void  (creator only)
    brushColor       – hex color string for brush strokes (creator only)
    brushWidth       – stroke width in canvas-space px (creator only)
*/
export default function DoodleCanvas({
  question,
  disabled = false,
  onSolve,
  isCreator = false,
  creatorMode = "pan",
  onElementsChange,
  brushColor = "#2f2a3c",
  brushWidth = 3,
  defaultZoneRole = "CORRECT_ANSWER",
  brushMode = "normal",
  onZoomPanChange,
  revealAnswers = false,
  playerClicks = [],
  selectedShapeType = "rect",
  selectedShapeColor = "#7c3aed",
  selectedShapeIsFilled = false,
  selectedShapeStrokeWidth = 3,
  style = {},
}) {
  const containerRef = useRef(null);
  const svgRef       = useRef(null);
  const bgSvgRef     = useRef(null);

  // Scale + Pan: kept in both state (render) and ref (event handlers, avoids stale closure)
  const [scale, _setScale] = useState(question?.zoomScale ?? 1);
  const scaleRef = useRef(question?.zoomScale ?? 1);
  const [pan, _setPan] = useState(question?.panOffset ?? { x: 0, y: 0 });
  const panRef = useRef(question?.panOffset ?? { x: 0, y: 0 });

  function doSetScale(v) { _setScale(v); scaleRef.current = v; }
  function doSetPan(v)   { _setPan(v);   panRef.current   = v; }

  // Live elements: local copy so player can drag ANSWER_BLOCKs at runtime
  const [liveElements, setLiveElements] = useState(question?.elements ?? []);
  const [gaugeValue,   setGaugeValue]   = useState(50);

  const creatorModeRef = useRef(creatorMode);
  useEffect(() => { creatorModeRef.current = creatorMode; }, [creatorMode]);

  const defaultZoneRoleRef = useRef(defaultZoneRole);
  useEffect(() => { defaultZoneRoleRef.current = defaultZoneRole; }, [defaultZoneRole]);

  // Notify parent of gauge changes immediately (so slider-only changes get recorded)
  useEffect(() => {
    if (!isCreator && onSolve) {
      onSolve({ rx: lastClickRef.current?.rx ?? null, ry: lastClickRef.current?.ry ?? null, gaugeValue, isGaugeUpdate: true });
    }
  }, [gaugeValue]); // eslint-disable-line react-hooks/exhaustive-deps

  // Draw-target mode: store canvas-space ratios on mousedown
  const [drawingRect, setDrawingRect] = useState(null); // live preview (ratios)
  const drawStartRatio = useRef(null); // { x, y } canvas-space ratios

  // Freeform-zone drawing: ref for stale-closure-safe point accumulation + state to trigger SVG redraw
  const drawingPolylineRef = useRef(null); // [{ x, y }] canvas-space ratios, null when inactive
  const [drawingPolyline, setDrawingPolyline] = useState(null);

  // Pan / click
  const panStartRef = useRef(null);
  const hasMoved    = useRef(false);

  // Element drag
  const elemDragRef = useRef(null);

  // Brush drawing: accumulate stroke points stale-closure-safe
  const currentBrushRef  = useRef(null);       // { color, width, pts: [{x,y}] } | null
  const [brushPreview, setBrushPreview] = useState(null);

  // Shape drawing states & refs
  const shapeDrawStartRef = useRef(null);
  const [drawingShape, setDrawingShape] = useState(null);
  const currentCustomShapeRef = useRef(null);
  const [customShapePreview, setCustomShapePreview] = useState(null);

  // Last canvas pointer-down position (canvas-space ratios) — used by paste handler
  const lastClickRef    = useRef({ rx: 0.5, ry: 0.5 });
  // Stable ref to onElementsChange so paste handler never captures stale prop
  const onElemChangeRef = useRef(onElementsChange);
  const onZoomPanChangeRef = useRef(onZoomPanChange);
  useEffect(() => { onZoomPanChangeRef.current = onZoomPanChange; }, [onZoomPanChange]);

  const [canvasWidth, setCanvasWidth] = useState(500);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        setCanvasWidth(entry.contentRect.width);
      }
    });
    observer.observe(el);
    setCanvasWidth(el.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);

  // Selection (creator only): which element is selected on the canvas
  const [selectedElemId, _setSelectedElemId] = useState(null);
  const selectedElemIdRef = useRef(null);
  function setSelectedElemId(id) { _setSelectedElemId(id); selectedElemIdRef.current = id; }

  // Inline text editing (creator only)
  const [editingTextId, setEditingTextId] = useState(null);
  const editingTextValueRef = useRef(""); // tracks latest keystroke value

  function commitTextEdit() {
    const id = editingTextId;
    if (!id) return;
    const newContent = editingTextValueRef.current;
    setLiveElements(prev => {
      const n = prev.map(x => x.id !== id ? x : { ...x, content: newContent });
      onElemChangeRef.current?.(n);
      return n;
    });
  }

  // Resize drag (creator only)
  const resizeDragRef = useRef(null);
  // {handle, id, type, containerW, containerH,
  //   startEl: {x_ratio,y_ratio,w_ratio,h_ratio} or null,
  //   startPts: [{x,y}] or null, startBBox or null,
  //   startCx, startCy}

  // ── Sync from question on id change ────────────────────────────────────────
  useEffect(() => {
    setLiveElements(question?.elements ? [...question.elements] : []);
    doSetScale(question?.zoomScale ?? 1);
    doSetPan(question?.panOffset ?? { x: 0, y: 0 });

    // Find GAUGE_BLOCK to initialize its value
    const gEl = question?.elements?.find(el => el.type === "GAUGE_BLOCK");
    if (gEl) {
      const ticks = gEl.labels ? gEl.labels.split(",").map(s => s.trim()).filter(Boolean) : [];
      let initVal = gEl.currentValue;
      if (ticks.length > 0) {
        if (!ticks.includes(initVal)) initVal = ticks[0];
      } else {
        initVal = Number(initVal ?? gEl.min ?? 0);
      }
      setGaugeValue(initVal);
    } else {
      setGaugeValue(50);
    }

    setDrawingRect(null);
    setSelectedElemId(null);
    editingTextValueRef.current = "";
    setEditingTextId(null);
  }, [question]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep onElemChangeRef current so paste handler never captures a stale prop
  useEffect(() => { onElemChangeRef.current = onElementsChange; }, [onElementsChange]);

  // Sync liveElements when parent question elements change (e.g. edited in sidebar)
  useEffect(() => {
    setLiveElements(question?.elements ? [...question.elements] : []);
  }, [question?.elements]);

  // Helper: push to both local state + parent
  function commitElements(newEls) {
    setLiveElements(newEls);
    onElementsChange?.(newEls);
  }

  // ── Resize handlers ────────────────────────────────────────────────────────
  function onResizeHandlePointerDown(e, handle, el) {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = containerRef.current?.getBoundingClientRect();
    const hasPts = el.type === "FREEFORM_ZONE" || el.type === "DRAWING_STROKE" || (el.type === "SHAPE_BLOCK" && el.shapeType === "custom");
    resizeDragRef.current = {
      handle,
      id: el.id,
      type: el.type,
      startCx: e.clientX,
      startCy: e.clientY,
      containerW: rect?.width  ?? 800,
      containerH: rect?.height ?? 480,
      startEl: hasPts ? null : {
        x_ratio: el.x_ratio,
        y_ratio: el.y_ratio,
        w_ratio: el.w_ratio,
        h_ratio: el.h_ratio,
        fontSizeScale: el.fontSizeScale ?? 1.0
      },
      startPts:  hasPts ? [...el.points_ratio] : null,
      startBBox: hasPts ? computeBBox(el.points_ratio) : null,
    };
  }

  function onResizeHandlePointerMove(e) {
    const rd = resizeDragRef.current;
    if (!rd) return;
    e.stopPropagation();
    const s = scaleRef.current;
    const dx = (e.clientX - rd.startCx) / (s * rd.containerW);
    const dy = (e.clientY - rd.startCy) / (s * rd.containerH);
    const h  = rd.handle;

    if (rd.startEl) {
      // Box element: update x/y/w/h
      let { x_ratio, y_ratio, w_ratio, h_ratio } = rd.startEl;
      if (h.includes("e")) w_ratio = Math.max(0.04, rd.startEl.w_ratio + dx);
      if (h.includes("s")) h_ratio = Math.max(0.04, rd.startEl.h_ratio + dy);
      if (h.includes("n")) {
        const newH = Math.max(0.04, rd.startEl.h_ratio - dy);
        y_ratio = rd.startEl.y_ratio + (rd.startEl.h_ratio - newH);
        h_ratio = newH;
      }
      if (h.includes("w")) {
        const newW = Math.max(0.04, rd.startEl.w_ratio - dx);
        x_ratio = rd.startEl.x_ratio + (rd.startEl.w_ratio - newW);
        w_ratio = newW;
      }

      // If dragging corner handles on a text block, scale font size proportionally
      let nextFontSizeScale = rd.startEl.fontSizeScale ?? 1.0;
      if (rd.type !== "IMAGE_BLOCK" && ["nw", "ne", "se", "sw"].includes(h)) {
        const scaleX = w_ratio / rd.startEl.w_ratio;
        nextFontSizeScale = Math.max(0.1, Math.min(10.0, (rd.startEl.fontSizeScale ?? 1.0) * scaleX));
      }

      setLiveElements(prev => prev.map(el => el.id !== rd.id ? el : {
        ...el,
        x_ratio,
        y_ratio,
        w_ratio,
        h_ratio,
        fontSizeScale: nextFontSizeScale
      }));
    } else if (rd.startBBox && rd.startPts) {
      // Points element: scale all points proportionally
      const old = rd.startBBox;
      let { bx, by, bw, bh } = old;
      if (h.includes("e")) bw = Math.max(0.02, old.bw + dx);
      if (h.includes("s")) bh = Math.max(0.02, old.bh + dy);
      if (h.includes("n")) { const nb = Math.max(0.02, old.bh - dy); by = old.by + (old.bh - nb); bh = nb; }
      if (h.includes("w")) { const nb = Math.max(0.02, old.bw - dx); bx = old.bx + (old.bw - nb); bw = nb; }
      const newPts = resizePoints(rd.startPts, old, { bx, by, bw, bh });
      setLiveElements(prev => prev.map(el => el.id !== rd.id ? el : { ...el, points_ratio: newPts }));
    }
  }

  function onResizeHandlePointerUp(e) {
    if (!resizeDragRef.current) return;
    e.stopPropagation();
    resizeDragRef.current = null;
    // Flush latest state to parent (functional updater avoids stale closure)
    setLiveElements(prev => { onElemChangeRef.current?.(prev); return prev; });
  }

  // §1 Z-index: SVG re-draws whenever the PRECISION_TARGET list itself changes
  // Stringify the targets so a ratio change (after drag) also triggers a redraw
  const targetJson = JSON.stringify(
    liveElements.filter(el =>
      el.type === "PRECISION_TARGET" ||
      el.type === "FREEFORM_ZONE"    ||
      el.type === "DRAWING_STROKE"
    )
  );

  useEffect(() => {
    const svg = bgSvgRef.current;
    if (!svg) return;
    const rc = rough.svg(svg);
    svg.innerHTML = "";
    svg.appendChild(rc.rectangle(4, 4, C_W - 8, C_H - 8, {
      roughness: 1.6, stroke: "#2f2a3c", strokeWidth: 2.5,
      fill: "#fffaf0", fillStyle: "solid",
    }));
  }, []);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const rc = rough.svg(svg);
    svg.innerHTML = "";

    // SHAPE_BLOCK: render hand-drawn shapes
    liveElements.filter(el => el.type === "SHAPE_BLOCK").forEach(el => {
      const stroke = el.color ?? "#2f2a3c";
      const strokeWidth = el.strokeWidth ?? 3;
      const fill = el.isFilled ? (el.color ?? "#7c3aed") : "none";
      const fillStyle = el.isFilled ? "solid" : "none";

      if (el.shapeType === "custom") {
        if (el.points_ratio?.length) {
          const pts = el.points_ratio.map(p => [C_W * p.x, C_H * p.y]);
          svg.appendChild(rc.polygon(pts, {
            roughness: 1.5,
            stroke,
            strokeWidth,
            fill,
            fillStyle,
          }));
        }
      } else {
        const x = C_W * el.x_ratio;
        const y = C_H * el.y_ratio;
        const w = Math.max(C_W * el.w_ratio, 4);
        const h = Math.max(C_H * el.h_ratio, 4);
        renderShapeHelper(svg, rc, el.shapeType || "rect", x, y, w, h, stroke, strokeWidth, fill, fillStyle);
      }
    });

    // DRAWING_STROKE: always visible to everyone (canvas decoration)
    liveElements.filter(el => el.type === "DRAWING_STROKE").forEach(el => {
      if (!el.points_ratio?.length) return;
      if (el.fill) {
        const polygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
        polygon.setAttribute("points", el.points_ratio.map(p => `${C_W * p.x},${C_H * p.y}`).join(" "));
        polygon.setAttribute("stroke",           el.color       ?? "#2f2a3c");
        polygon.setAttribute("stroke-width",     String(el.strokeWidth ?? 3));
        polygon.setAttribute("stroke-linecap",   "round");
        polygon.setAttribute("stroke-linejoin",  "round");
        polygon.setAttribute("fill",             el.color       ?? "#2f2a3c");
        polygon.setAttribute("fill-opacity",     "0.35");
        svg.appendChild(polygon);
      } else {
        const polyline = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
        polyline.setAttribute("points", el.points_ratio.map(p => `${C_W * p.x},${C_H * p.y}`).join(" "));
        polyline.setAttribute("stroke",           el.color       ?? "#2f2a3c");
        polyline.setAttribute("stroke-width",     String(el.strokeWidth ?? 3));
        polyline.setAttribute("stroke-linecap",   "round");
        polyline.setAttribute("stroke-linejoin",  "round");
        polyline.setAttribute("fill",             "none");
        svg.appendChild(polyline);
      }
    });

    if (isCreator || revealAnswers) {
      liveElements.filter(el => el.type === "PRECISION_TARGET").forEach((el, i) => {
        if (!isCreator && el.role === "DECOY") return;
        const x = C_W * el.x_ratio;
        const y = C_H * el.y_ratio;
        const w = Math.max(C_W * el.w_ratio, 4);
        const h = Math.max(C_H * el.h_ratio, 4);
        const isCorrect = el.role !== "DECOY";
        svg.appendChild(rc.rectangle(x, y, w, h, {
          roughness: 1.8, stroke: isCorrect ? "#22c55e" : "#ef4444", strokeWidth: 2,
          fill: isCorrect ? "#22c55e33" : "#ef444433", fillStyle: "cross-hatch",
        }));
        const lbl = document.createElementNS("http://www.w3.org/2000/svg", "text");
        lbl.setAttribute("x", String(x + 4));
        lbl.setAttribute("y", String(Math.max(y - 5, 14)));
        lbl.setAttribute("fill", isCorrect ? "#22c55e" : "#ef4444");
        lbl.setAttribute("font-size", "12");
        lbl.setAttribute("font-family", "Patrick Hand, sans-serif");
        lbl.textContent = isCorrect ? `✅ Zone ${i + 1}` : `🪤 Decoy ${i + 1}`;
        svg.appendChild(lbl);
      });

      // FREEFORM_ZONE: rough polygon outline, colour-coded by role
      liveElements.filter(el => el.type === "FREEFORM_ZONE").forEach((el, i) => {
        if (!isCreator && el.role === "DECOY") return;
        if (!el.points_ratio?.length) return;
        const pts = el.points_ratio.map(p => [C_W * p.x, C_H * p.y]);
        const isCorrect = el.role !== "DECOY";
        svg.appendChild(rc.polygon(pts, {
          roughness: 1.8, stroke: isCorrect ? "#22c55e" : "#ef4444", strokeWidth: 2,
          fill: isCorrect ? "#22c55e33" : "#ef444433", fillStyle: "cross-hatch",
        }));
        const lbl = document.createElementNS("http://www.w3.org/2000/svg", "text");
        lbl.setAttribute("x", String(C_W * el.points_ratio[0].x + 4));
        lbl.setAttribute("y", String(Math.max(C_H * el.points_ratio[0].y - 5, 14)));
        lbl.setAttribute("fill", isCorrect ? "#22c55e" : "#ef4444");
        lbl.setAttribute("font-size", "12");
        lbl.setAttribute("font-family", "Patrick Hand, sans-serif");
        lbl.textContent = isCorrect ? `✅ Zone ${i + 1}` : `🪤 Decoy ${i + 1}`;
        svg.appendChild(lbl);
      });

      if (isCreator) {
        // Live freeform preview: roughjs open path following the cursor
        if (drawingPolyline?.length > 1) {
          const pts = drawingPolyline.map(p => [C_W * p.x, C_H * p.y]);
          svg.appendChild(rc.linearPath(pts, {
            roughness: 1, stroke: "#7c3aed", strokeWidth: 2,
          }));
        }

        // Live brush stroke preview
        if (brushPreview?.pts?.length > 1) {
          const tag = brushMode === "fill" ? "polygon" : "polyline";
          const elPreview = document.createElementNS("http://www.w3.org/2000/svg", tag);
          elPreview.setAttribute("points", brushPreview.pts.map(p => `${C_W * p.x},${C_H * p.y}`).join(" "));
          elPreview.setAttribute("stroke",          brushPreview.color ?? "#2f2a3c");
          elPreview.setAttribute("stroke-width",    String(brushPreview.width ?? 3));
          elPreview.setAttribute("stroke-linecap",  "round");
          elPreview.setAttribute("stroke-linejoin", "round");
          elPreview.setAttribute("fill",            brushMode === "fill" ? (brushPreview.color ?? "#2f2a3c") : "none");
          if (brushMode === "fill") {
            elPreview.setAttribute("fill-opacity",  "0.35");
          }
          svg.appendChild(elPreview);
        }

        if (drawingRect) {
          const x = C_W * drawingRect.x_ratio;
          const y = C_H * drawingRect.y_ratio;
          const w = Math.max(C_W * drawingRect.w_ratio, 4);
          const h = Math.max(C_H * drawingRect.h_ratio, 4);
          svg.appendChild(rc.rectangle(x, y, w, h, {
            roughness: 1, stroke: "#7c3aed", strokeWidth: 2,
            fill: "#7c3aed22", fillStyle: "solid",
          }));
        }

        if (drawingShape) {
          const x = C_W * drawingShape.x_ratio;
          const y = C_H * drawingShape.y_ratio;
          const w = Math.max(C_W * drawingShape.w_ratio, 4);
          const h = Math.max(C_H * drawingShape.h_ratio, 4);
          const stroke = selectedShapeColor;
          const strokeWidth = selectedShapeStrokeWidth;
          const fill = selectedShapeIsFilled ? selectedShapeColor : "none";
          const fillStyle = selectedShapeIsFilled ? "solid" : "none";
          renderShapeHelper(svg, rc, drawingShape.shapeType, x, y, w, h, stroke, strokeWidth, fill, fillStyle);
        }

        if (customShapePreview && customShapePreview.length > 1) {
          const pts = customShapePreview.map(p => [C_W * p.x, C_H * p.y]);
          svg.appendChild(rc.linearPath(pts, {
            roughness: 1,
            stroke: selectedShapeColor,
            strokeWidth: selectedShapeStrokeWidth,
          }));
        }

        // Selection highlight: blue dashed rect around selected SVG-only element
        if (selectedElemId) {
          const sel = liveElements.find(el => el.id === selectedElemId);
          if (sel && (sel.type === "PRECISION_TARGET" || sel.type === "FREEFORM_ZONE" || sel.type === "DRAWING_STROKE" || sel.type === "SHAPE_BLOCK")) {
            let bx, by, bw, bh;
            if (sel.type === "PRECISION_TARGET" || (sel.type === "SHAPE_BLOCK" && sel.shapeType !== "custom")) {
              bx = C_W * sel.x_ratio; by = C_H * sel.y_ratio;
              bw = C_W * sel.w_ratio; bh = C_H * sel.h_ratio;
            } else {
              const xs = (sel.points_ratio ?? []).map(p => p.x);
              const ys = (sel.points_ratio ?? []).map(p => p.y);
              if (xs.length) {
                bx = C_W * Math.min(...xs); by = C_H * Math.min(...ys);
                bw = C_W * (Math.max(...xs) - Math.min(...xs));
                bh = C_H * (Math.max(...ys) - Math.min(...ys));
              }
            }
            if (bw > 0 && bh > 0) {
              const selRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
              selRect.setAttribute("x",      String(bx - 6));
              selRect.setAttribute("y",      String(by - 6));
              selRect.setAttribute("width",  String(bw + 12));
              selRect.setAttribute("height", String(bh + 12));
              selRect.setAttribute("fill",   "none");
              selRect.setAttribute("stroke", "#3b82f6");
              selRect.setAttribute("stroke-width", "2");
              selRect.setAttribute("stroke-dasharray", "6,3");
              selRect.setAttribute("rx", "4");
              svg.appendChild(selRect);
            }
          }
        }
      }
    }
    // Render player clicks markers if present (for multi-click questions)
    if (playerClicks && playerClicks.length > 0) {
      playerClicks.forEach((click, idx) => {
        const cx = C_W * click.rx;
        const cy = C_H * click.ry;

        const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
        
        const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        circle.setAttribute("cx", String(cx));
        circle.setAttribute("cy", String(cy));
        circle.setAttribute("r", "10");
        circle.setAttribute("fill", "#ef4444");
        circle.setAttribute("stroke", "#ffffff");
        circle.setAttribute("stroke-width", "2");

        const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
        text.setAttribute("x", String(cx));
        text.setAttribute("y", String(cy));
        text.setAttribute("dy", "3.5");
        text.setAttribute("text-anchor", "middle");
        text.setAttribute("fill", "#ffffff");
        text.setAttribute("font-size", "11");
        text.setAttribute("font-weight", "bold");
        text.setAttribute("font-family", "Patrick Hand, sans-serif");
        text.textContent = String(idx + 1);

        g.appendChild(circle);
        g.appendChild(text);
        svg.appendChild(g);
      });
    }
  }, [question, isCreator, revealAnswers, targetJson, drawingRect, drawingPolyline, brushPreview, selectedElemId, playerClicks, drawingShape, customShapePreview, selectedShapeColor, selectedShapeIsFilled, selectedShapeStrokeWidth]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Scroll-wheel zoom ──────────────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    function onWheel(e) {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 0.85;
      const newScale = Math.min(200, Math.max(0.005, scaleRef.current * factor));
      doSetScale(newScale);
      if (isCreator) {
        onZoomPanChangeRef.current?.({ zoomScale: newScale, panOffset: panRef.current });
      }
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [isCreator]);

  // ── Inverse matrix: screen pixel → canvas-space ratio (spec §3) ──────────────
  //
  //   Step 1 – subtract container origin to get px relative to container edge
  //   Step 2 – subtract panOffset  (undo CSS translate)
  //   Step 3 – divide by zoomScale (undo CSS scale)
  //   Step 4 – divide by container size to get [0,1] ratio
  //
  //   true_canvas_x = (mouseX - containerLeft - panOffset.x) / zoomScale
  //   x_ratio       = true_canvas_x / containerWidth
  //
  // Returns raw container-relative pixel coords too (needed for target-draw loop).
  function getHitCoords(clientX, clientY) {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return { px: 0, py: 0, rx: 0.5, ry: 0.5 };
    const p = panRef.current;
    const s = scaleRef.current;
    // Canvas-space pixels (undo pan + scale)
    const cx = (clientX - rect.left - p.x) / s;
    const cy = (clientY - rect.top  - p.y) / s;
    return {
      px: clientX - rect.left,   // raw px relative to container (for draw-target preview)
      py: clientY - rect.top,
      rx: cx / rect.width,
      ry: cy / rect.height,
      cw: rect.width,
      ch: rect.height,
    };
  }

  // ── Board pointer events ───────────────────────────────────────────────────

  function onPointerDown(e) {
    if ((!isCreator || creatorMode === "pan") && e.target.closest("[data-elem-id]")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    hasMoved.current = false;

    // Deselect when clicking empty canvas (creator, pan mode)
    if (isCreator && creatorMode === "pan") { commitTextEdit(); setSelectedElemId(null); setEditingTextId(null); }

    // Track last canvas click position for paste placement
    if (isCreator) {
      const { rx, ry } = getHitCoords(e.clientX, e.clientY);
      lastClickRef.current = { rx, ry };
    }

    // Brush drawing: start accumulating stroke points
    if (isCreator && creatorMode === "draw-brush" && !disabled) {
      const { rx, ry } = getHitCoords(e.clientX, e.clientY);
      const stroke = { color: brushColor, width: brushWidth, pts: [{ x: rx, y: ry }] };
      currentBrushRef.current = stroke;
      setBrushPreview({ ...stroke });
      return;
    }

    // §4 Target-draw loop: capture canvas-space ratios on mousedown
    if (isCreator && creatorMode === "draw-target" && !disabled) {
      const { rx, ry } = getHitCoords(e.clientX, e.clientY);
      drawStartRatio.current = { x: rx, y: ry };
      return;
    }

    // Freeform-zone: start drag-to-draw (like brush)
    if (isCreator && creatorMode === "draw-freeform" && !disabled) {
      const { rx, ry } = getHitCoords(e.clientX, e.clientY);
      drawingPolylineRef.current = [{ x: rx, y: ry }];
      setDrawingPolyline([{ x: rx, y: ry }]);
      return;
    }

    // Shape placing/drawing: start dragging preset shape or custom shape points
    if (isCreator && creatorMode === "place-shape" && !disabled) {
      const { rx, ry } = getHitCoords(e.clientX, e.clientY);
      if (selectedShapeType === "custom") {
        currentCustomShapeRef.current = [{ x: rx, y: ry }];
        setCustomShapePreview([{ x: rx, y: ry }]);
      } else {
        shapeDrawStartRef.current = { rx, ry };
        setDrawingShape({
          shapeType: selectedShapeType,
          x_ratio: rx,
          y_ratio: ry,
          w_ratio: 0,
          h_ratio: 0
        });
      }
      return;
    }

    panStartRef.current = {
      cx: e.clientX, cy: e.clientY,
      panX: panRef.current.x, panY: panRef.current.y,
    };
  }

  function onPointerMove(e) {
    // Resize drag: intercept before other handlers
    if (resizeDragRef.current) { onResizeHandlePointerMove(e); return; }

    // Brush drawing: append canvas-space ratio point at every move
    if (isCreator && creatorMode === "draw-brush" && currentBrushRef.current) {
      const { rx, ry } = getHitCoords(e.clientX, e.clientY);
      currentBrushRef.current.pts.push({ x: rx, y: ry });
      setBrushPreview({ ...currentBrushRef.current, pts: [...currentBrushRef.current.pts] });
      return;
    }

    // Freeform-zone: append points as they drag
    if (isCreator && creatorMode === "draw-freeform" && drawingPolylineRef.current) {
      const { rx, ry } = getHitCoords(e.clientX, e.clientY);
      const cur = drawingPolylineRef.current;
      const last = cur[cur.length - 1];
      if (Math.hypot(rx - last.x, ry - last.y) > 0.004) {
        const next = [...cur, { x: rx, y: ry }];
        drawingPolylineRef.current = next;
        setDrawingPolyline(next);
      }
      return;
    }

    // §4 Draw-target live preview
    if (isCreator && creatorMode === "draw-target" && drawStartRatio.current) {
      const { rx, ry } = getHitCoords(e.clientX, e.clientY);
      const s = drawStartRatio.current;
      const minX = Math.min(s.x, rx);
      const minY = Math.min(s.y, ry);
      setDrawingRect({
        x_ratio: minX,
        y_ratio: minY,
        w_ratio: Math.abs(rx - s.x),
        h_ratio: Math.abs(ry - s.y),
      });
      return;
    }

    // Shape placing/drawing: handle dragging for preset shape preview or custom shape
    if (isCreator && creatorMode === "place-shape") {
      const { rx, ry } = getHitCoords(e.clientX, e.clientY);
      if (selectedShapeType === "custom" && currentCustomShapeRef.current) {
        const pts = currentCustomShapeRef.current;
        const last = pts[pts.length - 1];
        if (Math.hypot(rx - last.x, ry - last.y) > 0.004) {
          pts.push({ x: rx, y: ry });
          setCustomShapePreview([...pts]);
        }
        return;
      } else if (shapeDrawStartRef.current) {
        const start = shapeDrawStartRef.current;
        const x_ratio = Math.min(start.rx, rx);
        const y_ratio = Math.min(start.ry, ry);
        const w_ratio = Math.abs(rx - start.rx);
        const h_ratio = Math.abs(ry - start.ry);
        setDrawingShape({
          shapeType: selectedShapeType,
          x_ratio,
          y_ratio,
          w_ratio,
          h_ratio
        });
        return;
      }
    }

    if (panStartRef.current) {
      const dx = e.clientX - panStartRef.current.cx;
      const dy = e.clientY - panStartRef.current.cy;
      if (Math.hypot(dx, dy) > DRAG_THRESHOLD) hasMoved.current = true;
      if (hasMoved.current) {
        const newPan = {
          x: panStartRef.current.panX + dx,
          y: panStartRef.current.panY + dy,
        };
        doSetPan(newPan);
        if (isCreator) {
          onZoomPanChangeRef.current?.({ zoomScale: scaleRef.current, panOffset: newPan });
        }
      }
    }
  }

  function onPointerUp(e) {

    // Resize drag: commit on release
    if (resizeDragRef.current) { onResizeHandlePointerUp(e); return; }

    // ── Brush drawing: commit stroke on mouseup ──────────────────────────────
    if (isCreator && creatorMode === "draw-brush" && currentBrushRef.current) {
      const stroke = currentBrushRef.current;
      currentBrushRef.current = null;
      setBrushPreview(null);
      if (stroke.pts.length >= 2) {
        commitElements([...liveElements, {
          id: randomUUID(),
          type: "DRAWING_STROKE",
          points_ratio: stroke.pts,
          color: stroke.color,
          strokeWidth: stroke.width,
          fill: brushMode === "fill",
        }]);
      }
      return;
    }

    // ── Freeform-zone: commit drag-to-draw shape as a closed polygon zone ──
    if (isCreator && creatorMode === "draw-freeform" && drawingPolylineRef.current) {
      const pts = drawingPolylineRef.current;
      drawingPolylineRef.current = null;
      setDrawingPolyline(null);
      if (pts.length >= 3) {
        commitElements([...liveElements, {
          id: randomUUID(),
          type: "FREEFORM_ZONE",
          points_ratio: pts,
          role: defaultZoneRole,
          isHidden: true,
        }]);
      }
      return;
    }

    // ── §4 End-to-end target loop: normalise bounding box at mouseup ────────
    // Capture mouseup canvas-space ratios, compute MinX/MinY/Width/Height.
    if (isCreator && creatorMode === "draw-target" && drawStartRatio.current) {
      const { rx, ry } = getHitCoords(e.clientX, e.clientY);
      const s = drawStartRatio.current;
      const minX = Math.min(s.x, rx);
      const minY = Math.min(s.y, ry);
      const w = Math.abs(rx - s.x);
      const h = Math.abs(ry - s.y);
      if (w > 0.01 && h > 0.01) {
        commitElements([...liveElements, {
          id: randomUUID(),
          type: "PRECISION_TARGET",
          x_ratio: minX,
          y_ratio: minY,
          w_ratio: w,
          h_ratio: h,
          isHidden: true,
        }]);
      }
      drawStartRatio.current = null;
      setDrawingRect(null);
      return;
    }

    // Shape placing/drawing: commit shape drawing on release
    if (isCreator && creatorMode === "place-shape") {
      if (selectedShapeType === "custom" && currentCustomShapeRef.current) {
        const pts = currentCustomShapeRef.current;
        currentCustomShapeRef.current = null;
        setCustomShapePreview(null);
        if (pts.length >= 3) {
          commitElements([...liveElements, {
            id: randomUUID(),
            type: "SHAPE_BLOCK",
            shapeType: "custom",
            color: selectedShapeColor,
            isFilled: selectedShapeIsFilled,
            strokeWidth: selectedShapeStrokeWidth,
            points_ratio: pts,
          }]);
        }
        return;
      } else if (shapeDrawStartRef.current) {
        const start = shapeDrawStartRef.current;
        shapeDrawStartRef.current = null;
        setDrawingShape(null);
        const { rx, ry } = getHitCoords(e.clientX, e.clientY);
        const x_ratio = Math.min(start.rx, rx);
        const y_ratio = Math.min(start.ry, ry);
        const w_ratio = Math.abs(rx - start.rx);
        const h_ratio = Math.abs(ry - start.ry);
        if (w_ratio > 0.01 && h_ratio > 0.01) {
          commitElements([...liveElements, {
            id: randomUUID(),
            type: "SHAPE_BLOCK",
            shapeType: selectedShapeType,
            color: selectedShapeColor,
            isFilled: selectedShapeIsFilled,
            strokeWidth: selectedShapeStrokeWidth,
            x_ratio,
            y_ratio,
            w_ratio,
            h_ratio,
          }]);
        }
        return;
      }
    }

    // ── Place TEXT_BLOCK, ANSWER_BLOCK, or GAUGE_BLOCK ───────────────────────
    if (isCreator && (creatorMode === "place-text" || creatorMode === "place-answer" || creatorMode === "place-gauge") && !hasMoved.current) {
      // §3 inverse matrix: undo pan + scale before ratio conversion
      const { rx, ry } = getHitCoords(e.clientX, e.clientY);
      const s = scaleRef.current;
      
      if (creatorMode === "place-gauge") {
        commitElements([...liveElements, {
          id: randomUUID(),
          type: "GAUGE_BLOCK",
          x_ratio: rx - (0.25 / s),
          y_ratio: ry - (0.09 / s),
          w_ratio: 0.50 / s,
          h_ratio: 0.18 / s,
          title: "Kéo thước đo (Slider)",
          min: 0,
          max: 100,
          step: 1,
          correctMin: 40,
          correctMax: 60,
          labels: "",
          correctValue: "50",
          currentValue: "50",
          color: "#7c3aed",
        }]);
      } else {
        const isAnswer = creatorMode === "place-answer";
        commitElements([...liveElements, {
          id: randomUUID(),
          type: isAnswer ? "ANSWER_BLOCK" : "TEXT_BLOCK",
          content: isAnswer ? "Move me! 🙈" : "Text Block",
          x_ratio: rx - (0.11 / s),
          y_ratio: ry - (0.05 / s),
          w_ratio: 0.22 / s,
          h_ratio: 0.10 / s,
          fontSizeScale: 1.0,
          isMovableByPlayer: isAnswer,
        }]);
      }
      panStartRef.current = null;
      return;
    }

    // ── Player click: §1 backwards scan + §3 inverse matrix hit test ────────
    if (!isCreator && !hasMoved.current && panStartRef.current) {
      if (disabled) {
        panStartRef.current = null;
        hasMoved.current = false;
        return;
      }
      const hasGauge = liveElements.some(el => el.type === "GAUGE_BLOCK");
      if (hasGauge) {
        panStartRef.current = null;
        hasMoved.current = false;
        return; // Ignore canvas clicks for players if a slider is present!
      }
      const { rx, ry } = getHitCoords(e.clientX, e.clientY);
      const gaugeEl    = liveElements.find(el => el.type === "GAUGE_BLOCK");
      const gaugeOk    = !gaugeEl ||
        typeof gaugeEl.correctMin !== "number" ||
        (gaugeValue >= gaugeEl.correctMin && gaugeValue <= gaugeEl.correctMax);

      // §1 backwards scan: topmost element wins (highest index = rendered last = on top)
      let hit = false;
      for (let i = liveElements.length - 1; i >= 0; i--) {
        const el = liveElements[i];
        if (el.type === "PRECISION_TARGET" && el.role !== "DECOY") {
          if (
            rx >= el.x_ratio && rx <= el.x_ratio + el.w_ratio &&
            ry >= el.y_ratio && ry <= el.y_ratio + el.h_ratio
          ) { hit = true; break; }
        } else if (el.type === "FREEFORM_ZONE" && el.role !== "DECOY") {
          // Ray-casting point-in-polygon: accurate for any convex or concave freeform shape
          if (el.points_ratio?.length >= 3 && pointInPolygon(rx, ry, el.points_ratio)) {
            hit = true; break;
          }
        }
      }

      // Always notify page of the click coords (server is the authority).
      // isLocalHit is just for UX (early-win overlay); server re-validates.
      onSolve?.({ rx, ry, gaugeValue, isLocalHit: hit && gaugeOk });
    }

    panStartRef.current = null;
    hasMoved.current    = false;
  }

  // ── Element drag (ANSWER_BLOCK movable by players; all blocks by creator) ──

  function onElemPointerDown(e, el) {
    // Select element on click in creator pan mode
    if (isCreator && creatorMode === "pan") setSelectedElemId(el.id);
    // Don't start a drag while the user is editing this element's text
    if (editingTextId === el.id) return;
    const canDrag = isCreator || (el.isMovableByPlayer && !disabled);
    if (!canDrag) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = containerRef.current?.getBoundingClientRect();
    elemDragRef.current = {
      id: el.id,
      startCx: e.clientX, startCy: e.clientY,
      startXR: el.x_ratio, startYR: el.y_ratio,
      // §2 live container dimensions, not hardcoded constants
      containerW: rect?.width  ?? 800,
      containerH: rect?.height ?? 480,
      hasMoved: false,
    };
  }

  function onElemPointerMove(e) {
    const bd = elemDragRef.current;
    if (!bd) return;
    e.stopPropagation();
    const s = scaleRef.current;
    // §3 inverse matrix: pixel delta in screen space → canvas-space delta → ratio delta
    //   canvas_delta = screen_delta / zoomScale
    //   ratio_delta  = canvas_delta / containerSize
    const dx = (e.clientX - bd.startCx) / (s * bd.containerW);
    const dy = (e.clientY - bd.startCy) / (s * bd.containerH);
    if (Math.hypot(e.clientX - bd.startCx, e.clientY - bd.startCy) > DRAG_THRESHOLD) bd.hasMoved = true;
    if (!bd.hasMoved) return;
    setLiveElements(prev => prev.map(el => el.id !== bd.id ? el : {
      ...el,
      x_ratio: bd.startXR + dx,
      y_ratio: bd.startYR + dy,
    }));
  }

  function onElemPointerUp(e) {
    const bd = elemDragRef.current;
    if (!bd) return;
    e.stopPropagation();
    // Persist final ratio positions to parent (§2: only ratios stored, never raw px)
    if (isCreator && bd.hasMoved) {
      setLiveElements(latest => {
        onElemChangeRef.current?.(latest);
        return latest;
      });
    }
    elemDragRef.current = null;
  }

  // ── Clipboard copy handler ────────────────────────────────────────────────
  useEffect(() => {
    if (!isCreator) return;
    const container = containerRef.current;
    if (!container) return;
    function handleCopy(e) {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      const id = selectedElemIdRef.current;
      if (id) {
        const el = liveElements.find(x => x.id === id);
        if (el) {
          e.clipboardData?.setData("text/plain", `[doodle-element:${JSON.stringify(el)}]`);
          e.preventDefault();
        }
      }
    }
    container.addEventListener("copy", handleCopy);
    return () => container.removeEventListener("copy", handleCopy);
  }, [isCreator, liveElements]);

  // ── Clipboard paste: image → IMAGE_BLOCK, text → TEXT_BLOCK ───────────────────
  // Container needs tabIndex so clicking it gives focus, enabling Ctrl+V
  useEffect(() => {
    if (!isCreator) return;
    const container = containerRef.current;
    if (!container) return;
    function handlePaste(e) {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      const items = [...(e.clipboardData?.items ?? [])];
      // Image takes priority over plain text
      const imgItem = items.find(it => it.type.startsWith("image/"));
      if (imgItem) {
        e.preventDefault();
        const blob = imgItem.getAsFile();
        const reader = new FileReader();
        reader.onload = ev => {
          const { rx, ry } = lastClickRef.current;
          const s = scaleRef.current;
          const newEl = {
            id: randomUUID(),
            type: "IMAGE_BLOCK",
            src: ev.target.result,
            x_ratio: rx - (0.15 / s),
            y_ratio: ry - (0.10 / s),
            w_ratio: 0.30 / s,
            h_ratio: 0.20 / s,
          };
          setLiveElements(prev => { const n = [...prev, newEl]; onElemChangeRef.current?.(n); return n; });
        };
        reader.readAsDataURL(blob);
        return;
      }
      const txtItem = items.find(it => it.type === "text/plain");
      if (txtItem) {
        txtItem.getAsString(text => {
          if (!text.trim()) return;
          e.preventDefault();
          const { rx, ry } = lastClickRef.current;
          const s = scaleRef.current;

          // Check if it's a custom serialized doodle element
          if (text.startsWith("[doodle-element:")) {
            try {
              const jsonStr = text.slice("[doodle-element:".length, -1);
              const el = JSON.parse(jsonStr);
              const newEl = {
                ...el,
                id: randomUUID(),
                x_ratio: rx - (el.w_ratio / 2),
                y_ratio: ry - (el.h_ratio / 2),
              };
              
              const isSamePos = Math.abs(newEl.x_ratio - el.x_ratio) < 0.01 && Math.abs(newEl.y_ratio - el.y_ratio) < 0.01;
              if (isSamePos) {
                newEl.x_ratio += 0.04;
                newEl.y_ratio += 0.04;
              }

              if (el.points_ratio) {
                const oldBBox = computeBBox(el.points_ratio);
                const nextBBox = { bx: newEl.x_ratio, by: newEl.y_ratio, bw: el.w_ratio, bh: el.h_ratio };
                newEl.points_ratio = resizePoints(el.points_ratio, oldBBox, nextBBox);
              }
              setLiveElements(prev => { const n = [...prev, newEl]; onElemChangeRef.current?.(n); return n; });
              setSelectedElemId(newEl.id);
              return;
            } catch (err) {
              console.error("Paste custom element error:", err);
            }
          }

          // Fallback: paste standard text block
          const newEl = {
            id: randomUUID(),
            type: "TEXT_BLOCK",
            content: text.trim().slice(0, 200),
            x_ratio: rx - (0.11 / s),
            y_ratio: ry - (0.05 / s),
            w_ratio: 0.22 / s,
            h_ratio: 0.10 / s,
            fontSizeScale: 1.0,
            isMovableByPlayer: false,
          };
          setLiveElements(prev => { const n = [...prev, newEl]; onElemChangeRef.current?.(n); return n; });
        });
      }
    }
    container.addEventListener("paste", handlePaste);
    return () => container.removeEventListener("paste", handlePaste);
  }, [isCreator]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Delete / Backspace: remove the currently selected element ─────────────
  useEffect(() => {
    if (!isCreator) return;
    const container = containerRef.current;
    if (!container) return;
    function onKeyDown(e) {
      const mode = creatorModeRef.current;
      const poly = drawingPolylineRef.current;

      // Handle drawing polyline keys
      if (mode === "draw-freeform" && poly && poly.length > 0) {
        if (e.key === "Backspace") {
          e.preventDefault();
          const next = poly.slice(0, -1);
          if (next.length === 0) {
            drawingPolylineRef.current = null;
            setDrawingPolyline(null);
          } else {
            drawingPolylineRef.current = next;
            setDrawingPolyline(next);
          }
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          drawingPolylineRef.current = null;
          setDrawingPolyline(null);
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          if (poly.length >= 3) {
            const pts = [...poly];
            drawingPolylineRef.current = null;
            setDrawingPolyline(null);
            setLiveElements(prev => {
              const newEls = [...prev, {
                id: randomUUID(),
                type: "FREEFORM_ZONE",
                points_ratio: pts,
                role: defaultZoneRoleRef.current,
                isHidden: true,
              }];
              onElemChangeRef.current?.(newEls);
              return newEls;
            });
          }
          return;
        }
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
        if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
        const id = selectedElemIdRef.current;
        if (id) {
          e.preventDefault();
          const el = liveElements.find(x => x.id === id);
          if (el) {
            const newEl = {
              ...el,
              id: randomUUID(),
              x_ratio: el.x_ratio + 0.04,
              y_ratio: el.y_ratio + 0.04,
            };
            if (el.points_ratio) {
              newEl.points_ratio = el.points_ratio.map(p => ({ x: p.x + 0.04, y: p.y + 0.04 }));
            }
            setLiveElements(prev => {
              const n = [...prev, newEl];
              onElemChangeRef.current?.(n);
              return n;
            });
            setSelectedElemId(newEl.id);
          }
        }
        return;
      }

      if (e.key !== "Delete" && e.key !== "Backspace") return;
      // Only if the canvas container (not a text input) has focus
      if (e.target !== container) return;
      const id = selectedElemIdRef.current;
      if (!id) return;
      e.preventDefault();
      setSelectedElemId(null);
      setLiveElements(prev => {
        const n = prev.filter(el => el.id !== id);
        onElemChangeRef.current?.(n);
        return n;
      });
    }
    container.addEventListener("keydown", onKeyDown);
    return () => container.removeEventListener("keydown", onKeyDown);
  }, [isCreator]); // eslint-disable-line react-hooks/exhaustive-deps

  const adjustTextareaParentHeight = (textarea, scaleFactor, hRatio) => {
    if (!textarea) return;
    const parent = textarea.parentElement;
    if (parent) {
      textarea.style.height = 'auto';
      const unscaledHeight = textarea.scrollHeight;
      textarea.style.height = `${unscaledHeight}px`;
      const visualHeight = unscaledHeight * scaleFactor;
      const minParentHeight = hRatio * canvasWidth;
      parent.style.minHeight = `${Math.max(minParentHeight, visualHeight)}px`;
    }
  };

  const cursor = disabled ? "default"
    : isCreator && creatorMode === "draw-target"   ? "crosshair"
    : isCreator && creatorMode === "draw-freeform" ? "crosshair"
    : isCreator && creatorMode === "draw-brush"    ? "crosshair"
    : isCreator && creatorMode === "place-text"    ? "text"
    : isCreator && creatorMode === "place-answer"  ? "cell"
    : isCreator && creatorMode === "place-shape"   ? "crosshair"
    : isCreator && creatorMode === "place-gauge"   ? "pointer"
    : "grab";

  const gaugeEl = liveElements.find(el => el.type === "GAUGE_BLOCK");
  // §1 Z-index array: render in forward order (index 0 = bottom, last = top)
  // TEXT_BLOCK, ANSWER_BLOCK, IMAGE_BLOCK rendered as DOM; DRAWING_STROKE in SVG; zones SVG-only
  const domBlocks = liveElements.filter(el =>
    el.type === "TEXT_BLOCK" || el.type === "ANSWER_BLOCK" || el.type === "IMAGE_BLOCK" || el.type === "GAUGE_BLOCK"
  );

  return (
    <div
      className="doodle-board"
      style={{
        userSelect: "none",
        touchAction: "none",
        position: "relative",
        outline: "none",
        width: "100%",
        maxWidth: isCreator
          ? "min(100%, calc((16 / 9) * (100vh - 200px)))"
          : (gaugeEl ? "min(100%, calc((16 / 9) * (100vh - 110px)))" : "min(100%, calc((16 / 9) * (100vh - 55px)))"),
        margin: "0 auto",
        minHeight: "unset",
        ...style,
      }}
    >
      <div
        ref={containerRef}
        tabIndex={isCreator ? 0 : undefined}
        style={{
          position: "relative",
          width: "100%",
          aspectRatio: "16 / 9",
          overflow: "hidden",
          background: "transparent",
          outline: "none",
          containerType: "inline-size",
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {/*
          TWO-LAYER COORDINATE MAPPING (spec §4)
          Layer 1 – transform wrapper: applies zoom + pan.
                    All child elements use ratio-based percentages inside this layer.
          Layer 2 – hit detection: getCanvasRatio() applies the inverse transform
                    so clicks are accurate regardless of zoom level.
        */}
        <div style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
          transformOrigin: "0 0",
          position: "absolute",
          inset: 0,
          cursor,
          overflow: "visible",
        }}>
        {/* Background SVG layer: rough border and fill */}
        <svg
          ref={bgSvgRef}
          viewBox="-2000 -2000 4500 4500"
          preserveAspectRatio="none"
          style={{ position: "absolute", width: "900%", height: "900%", left: "-400%", top: "-400%", pointerEvents: "none", overflow: "visible" }}
        />

        {question?.canvasImage && (
          <img
            src={question.canvasImage}
            alt="canvas bg"
            style={{
              position: "absolute", inset: 0, width: "100%", height: "100%",
              objectFit: question.canvasImageFit ?? "contain", pointerEvents: "none",
              zIndex: 1,
            }}
          />
        )}

        {/* §1 DOM layer: forward-order render */}
        {domBlocks.map((el, arrayIdx) => {
          const isSelected = isCreator && el.id === selectedElemId;
          const elementIdx = liveElements.indexOf(el);
          const isText = el.type === "TEXT_BLOCK" || el.type === "ANSWER_BLOCK";
          const scaleFactor = Math.max(0.0001, isText
            ? (0.028 * (el.fontSizeScale ?? 1.0) * canvasWidth) / 40
            : 1.0);
          return (
          <div
            key={el.id}
            data-elem-id={el.id}
            style={{
              position: "absolute",
              // §2 ratio → px: multiply by 100 for CSS %, browser computes live px
              left:      `${el.x_ratio * 100}%`,
              top:       `${el.y_ratio * 100}%`,
              width:     `${el.w_ratio * 100}%`,
              minHeight: `${el.h_ratio * 100}%`,
              border: isSelected
                ? "2px dashed #3b82f6"
                : el.type === "IMAGE_BLOCK"
                ? (isCreator ? "2px dashed #94a3b8" : "none")
                : "none",
              boxShadow: isSelected ? "0 0 0 3px #3b82f640" : undefined,
              borderRadius: el.type === "IMAGE_BLOCK" ? 4 : 0,
              background: "transparent",
              padding: 0,
              fontFamily: "Patrick Hand, cursive",
              containerType: "inline-size",
              cursor: (el.isMovableByPlayer || isCreator) ? "grab" : "default",
              // Use its index in liveElements to stack elements correctly
              zIndex: elementIdx + 2,
              touchAction: "none",
              pointerEvents: (isCreator && creatorMode !== "pan")
                ? "none"
                : (el.type === "ANSWER_BLOCK" || isCreator || el.isMovableByPlayer)
                ? "auto"
                : "none",
              boxSizing: "border-box",
              overflow: (el.type === "GAUGE_BLOCK" || (isCreator && creatorMode === "pan")) ? "visible" : "hidden",
              display: "flex", alignItems: "center", justifyContent: "center",
              textAlign: "center",
              // IMAGE_BLOCK and GAUGE_BLOCK use fixed height; text blocks use minHeight to allow wrapping
              ...((el.type === "IMAGE_BLOCK" || el.type === "GAUGE_BLOCK")
                ? { height: `${el.h_ratio * 100}%` }
                : { minHeight: `${el.h_ratio * 100}%` }),
            }}
            onPointerDown={e => onElemPointerDown(e, el)}
            onPointerMove={onElemPointerMove}
            onPointerUp={onElemPointerUp}
            onDoubleClick={e => {
              if (!isCreator) return;
              if (el.type === "TEXT_BLOCK" || el.type === "ANSWER_BLOCK") {
                e.stopPropagation();
                // seed the ref with current content so commitTextEdit has the right base
                const cur = liveElements.find(x => x.id === el.id);
                editingTextValueRef.current = cur?.content ?? "";
                setEditingTextId(el.id);
                setSelectedElemId(el.id);
              }
            }}
          >
            {/* Selection delete button */}
            {isSelected && (
              <button
                type="button"
                style={{
                  position: "absolute", top: 3, right: 3,
                  width: 20, height: 20, borderRadius: "50%",
                  background: "#ef4444", color: "#fff", border: "none",
                  cursor: "pointer", fontSize: 13, lineHeight: 1,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.35)", zIndex: 1,
                }}
                onPointerDown={e => e.stopPropagation()}
                onClick={e => {
                  e.stopPropagation();
                  commitTextEdit();
                  setSelectedElemId(null);
                  setEditingTextId(null);
                  setLiveElements(prev => {
                    const n = prev.filter(x => x.id !== el.id);
                    onElemChangeRef.current?.(n);
                    return n;
                  });
                }}
              >×</button>
            )}
            {isCreator && creatorMode === "pan" && (
              <ResizeHandles active={isSelected} onHandleDown={(e, h) => onResizeHandlePointerDown(e, h, el)} />
            )}
            {(el.type === "TEXT_BLOCK" || el.type === "ANSWER_BLOCK") && (
              <HandDrawnBackground
                canvasWidth={canvasWidth}
                elColor={el.color}
                isAnswer={el.type === "ANSWER_BLOCK"}
                isMovable={el.isMovableByPlayer}
                isSelected={isSelected}
              />
            )}
            {el.type === "IMAGE_BLOCK" ? (
              <img
                src={el.src}
                alt=""
                draggable={false}
                style={{ width: "100%", height: "100%", objectFit: "contain", display: "block", pointerEvents: "none" }}
              />
            ) : el.type === "GAUGE_BLOCK" ? (
              <GaugeWidget
                el={el}
                isCreator={isCreator}
                creatorMode={creatorMode}
                isSelected={isSelected}
                canvasWidth={canvasWidth}
                revealAnswers={revealAnswers}
                onValueChange={(val) => {
                  setLiveElements(prev => {
                    const n = prev.map(x => x.id !== el.id ? x : { ...x, currentValue: String(val) });
                    onElemChangeRef.current?.(n);
                    return n;
                  });
                  setGaugeValue(val);
                }}
              />
            ) : editingTextId === el.id ? (
              /* Inline textarea edit */
              <textarea
                autoFocus
                defaultValue={el.content}
                ref={node => {
                  if (node) {
                    adjustTextareaParentHeight(node, scaleFactor, el.h_ratio);
                  }
                }}
                style={{
                  position: "absolute",
                  left: "50%",
                  top: "50%",
                  width: `${90 / scaleFactor}%`,
                  transform: `translate(-50%, -50%) scale(${scaleFactor})`,
                  transformOrigin: "center center",
                  zIndex: 2,
                  border: "none",
                  outline: "none",
                  resize: "none",
                  background: "transparent",
                  fontFamily: "Patrick Hand, cursive",
                  fontSize: "40px",
                  lineHeight: "1.2",
                  textAlign: "center",
                  padding: "2px 4px",
                  cursor: "text",
                  boxSizing: "border-box",
                }}
                onPointerDown={e => e.stopPropagation()}
                onChange={e => {
                  editingTextValueRef.current = e.target.value;
                  adjustTextareaParentHeight(e.target, scaleFactor, el.h_ratio);
                }}
                onBlur={() => { commitTextEdit(); setEditingTextId(null); }}
              />
            ) : (
              <div
                ref={node => {
                  if (node) {
                    const parent = node.parentElement;
                    if (parent) {
                      const unscaledHeight = node.offsetHeight;
                      const visualHeight = unscaledHeight * scaleFactor;
                      const minParentHeight = el.h_ratio * canvasWidth;
                      
                      let fitScale = 1.0;
                      if (visualHeight > minParentHeight && minParentHeight > 0) {
                        fitScale = minParentHeight / visualHeight;
                      }
                      
                      node.style.transform = `translate(-50%, -50%) scale(${scaleFactor * fitScale})`;
                      parent.style.height = `${minParentHeight}px`;
                      parent.style.minHeight = `${minParentHeight}px`;
                    }
                  }
                }}
                style={{
                  position: "absolute",
                  left: "50%",
                  top: "50%",
                  width: `${90 / scaleFactor}%`,
                  transform: `translate(-50%, -50%) scale(${scaleFactor})`,
                  transformOrigin: "center center",
                  zIndex: 2,
                  fontSize: "40px",
                  lineHeight: "1.2",
                  textAlign: "center",
                  display: "block",
                  wordBreak: "break-word",
                  pointerEvents: "none",
                }}
              >
                {el.content}
                {isCreator && el.isMovableByPlayer && (
                  <span style={{ marginLeft: 4, fontSize: "28px", opacity: 0.55, display: "inline-block", verticalAlign: "middle" }}>⇕</span>
                )}
              </div>
            )}
          </div>
          );
        })}

        {/* Foreground SVG layer: targets, zones, drawings, previews, selection highlights */}
        <svg
          ref={svgRef}
          viewBox="-2000 -2000 4500 4500"
          preserveAspectRatio="none"
          style={{ position: "absolute", width: "900%", height: "900%", left: "-400%", top: "-400%", pointerEvents: "none", zIndex: 100, overflow: "visible" }}
        />

        {/* ── Transparent hit-areas for SVG-only elements (creator select mode) ── */}
        {isCreator && liveElements
          .filter(el => el.type === "PRECISION_TARGET" || el.type === "FREEFORM_ZONE" || el.type === "DRAWING_STROKE" || el.type === "SHAPE_BLOCK")
          .map(el => {
            let bx, by, bw, bh;
            if (el.type === "PRECISION_TARGET" || (el.type === "SHAPE_BLOCK" && el.shapeType !== "custom")) {
              bx = el.x_ratio; by = el.y_ratio; bw = el.w_ratio; bh = el.h_ratio;
            } else {
              const pts = el.points_ratio ?? [];
              if (!pts.length) return null;
              const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
              bx = Math.min(...xs); by = Math.min(...ys);
              bw = Math.max(...xs) - bx; bh = Math.max(...ys) - by;
            }
            const PAD = 0.01;
            const ox = bx - PAD, oy = by - PAD;
            const ow = bw + PAD * 2, oh = bh + PAD * 2;
            const isSelected = el.id === selectedElemId;
            const elementIdx = liveElements.indexOf(el);
            return (
              <div
                key={`sel-${el.id}`}
                style={{
                  position: "absolute",
                  left: `${ox * 100}%`, top: `${oy * 100}%`,
                  width: `${ow * 100}%`, height: `${oh * 100}%`,
                  border: isSelected ? "2px dashed #3b82f6" : "2px dashed transparent",
                  borderRadius: 4,
                  boxShadow: isSelected ? "0 0 0 3px #3b82f640" : undefined,
                  zIndex: elementIdx + 2,
                  overflow: "visible",
                  pointerEvents: creatorMode === "pan" ? "all" : "none",
                  cursor: "pointer",
                }}
                onPointerDown={e => {
                  e.stopPropagation();
                  setSelectedElemId(el.id);
                  if (creatorMode === "pan") {
                    e.currentTarget.setPointerCapture(e.pointerId);
                    const rect = containerRef.current?.getBoundingClientRect();
                    elemDragRef.current = {
                      id: el.id,
                      type: el.type,
                      startCx: e.clientX, startCy: e.clientY,
                      containerW: rect?.width ?? 800,
                      containerH: rect?.height ?? 480,
                      hasMoved: false,
                      startPts: el.points_ratio ? el.points_ratio.map(p => ({ x: p.x, y: p.y })) : null,
                      startXR: el.x_ratio,
                      startYR: el.y_ratio,
                    };
                  }
                }}
                onPointerMove={e => {
                  const bd = elemDragRef.current;
                  if (!bd || bd.id !== el.id) return;
                  e.stopPropagation();
                  const s = scaleRef.current;
                  const dx = (e.clientX - bd.startCx) / (s * bd.containerW);
                  const dy = (e.clientY - bd.startCy) / (s * bd.containerH);
                  if (Math.hypot(e.clientX - bd.startCx, e.clientY - bd.startCy) > DRAG_THRESHOLD) bd.hasMoved = true;
                  if (!bd.hasMoved) return;

                  if (bd.startPts) {
                    const nextPts = bd.startPts.map(p => ({
                      x: p.x + dx,
                      y: p.y + dy,
                    }));
                    setLiveElements(prev => prev.map(x => x.id !== bd.id ? x : { ...x, points_ratio: nextPts }));
                  } else {
                    setLiveElements(prev => prev.map(x => x.id !== bd.id ? x : {
                      ...x,
                      x_ratio: bd.startXR + dx,
                      y_ratio: bd.startYR + dy,
                    }));
                  }
                }}
                onPointerUp={e => {
                  const bd = elemDragRef.current;
                  if (!bd || bd.id !== el.id) return;
                  e.stopPropagation();
                  if (bd.hasMoved) {
                    setLiveElements(latest => {
                      onElemChangeRef.current?.(latest);
                      return latest;
                    });
                  }
                  elemDragRef.current = null;
                }}
              >
                {isSelected && (
                  <>
                  <button
                    type="button"
                    style={{
                      position: "absolute", top: 3, right: 3,
                      width: 20, height: 20, borderRadius: "50%",
                      background: "#ef4444", color: "#fff", border: "none",
                      cursor: "pointer", fontSize: 13, lineHeight: 1,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      boxShadow: "0 1px 3px rgba(0,0,0,0.35)", zIndex: 1,
                    }}
                    onPointerDown={e => e.stopPropagation()}
                    onClick={e => {
                      e.stopPropagation();
                      setSelectedElemId(null);
                      setLiveElements(prev => {
                        const n = prev.filter(x => x.id !== el.id);
                        onElemChangeRef.current?.(n);
                        return n;
                      });
                    }}
                  >×</button>
                  <ResizeHandles active={true} onHandleDown={(e, h) => onResizeHandlePointerDown(e, h, el)} />
                  </>
                )}
                {!isSelected && creatorMode === "pan" && (
                  <ResizeHandles active={false} onHandleDown={(e, h) => { setSelectedElemId(el.id); onResizeHandlePointerDown(e, h, el); }} />
                )}
              </div>
            );
          })}
        </div>
      </div>



      {/* Controls bar */}
      <div style={{
        padding: "6px 12px", borderTop: "2px solid #2f2a3c", background: "#fffdf6",
        display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap",
      }}>
        <span className="badge">🔍 {scale < 0.1 ? `${(scale * 100).toFixed(1)}%` : `${Math.round(scale * 100)}%`}</span>
        <button
          type="button" className="btn secondary"
          style={{ padding: "4px 10px", fontSize: "0.82rem" }}
          disabled={disabled}
          onClick={() => {
            doSetScale(question?.zoomScale ?? 1);
            doSetPan(question?.panOffset ?? { x: 0, y: 0 });
          }}
        >
          Reset View
        </button>
        {!isCreator && !disabled && (
          <span style={{ fontSize: "0.78rem", opacity: 0.5 }}>
            Scroll to zoom · Drag to pan · Click to find the trap!
          </span>
        )}
      </div>
    </div>
  );
}

