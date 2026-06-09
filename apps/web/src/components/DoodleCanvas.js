"use client";

import { useEffect, useRef, useState } from "react";
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

  // Draw-target mode: store raw pixel coords relative to container on mousedown,
  // then normalise to ratios on mouseup (spec §4 end-to-end target loop)
  const [drawingRect, setDrawingRect] = useState(null); // live preview (ratios)
  const drawStartPx  = useRef(null); // { x, y } raw pixels relative to container

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

  // Last canvas pointer-down position (canvas-space ratios) — used by paste handler
  const lastClickRef    = useRef({ rx: 0.5, ry: 0.5 });
  // Stable ref to onElementsChange so paste handler never captures stale prop
  const onElemChangeRef = useRef(onElementsChange);
  const onZoomPanChangeRef = useRef(onZoomPanChange);
  useEffect(() => { onZoomPanChangeRef.current = onZoomPanChange; }, [onZoomPanChange]);

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
    setGaugeValue(50);
    setDrawingRect(null);
    setSelectedElemId(null);
    editingTextValueRef.current = "";
    setEditingTextId(null);
  }, [question?.id]); // eslint-disable-line react-hooks/exhaustive-deps

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
    const hasPts = el.type === "FREEFORM_ZONE" || el.type === "DRAWING_STROKE";
    resizeDragRef.current = {
      handle,
      id: el.id,
      type: el.type,
      startCx: e.clientX,
      startCy: e.clientY,
      containerW: rect?.width  ?? 800,
      containerH: rect?.height ?? 480,
      startEl: hasPts ? null : { x_ratio: el.x_ratio, y_ratio: el.y_ratio, w_ratio: el.w_ratio, h_ratio: el.h_ratio },
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
      setLiveElements(prev => prev.map(el => el.id !== rd.id ? el : { ...el, x_ratio, y_ratio, w_ratio, h_ratio }));
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
        const x = C_W * el.x_ratio;
        const y = C_H * el.y_ratio;
        const w = Math.max(C_W * el.w_ratio, 4);
        const h = Math.max(C_H * el.h_ratio, 4);
        svg.appendChild(rc.rectangle(x, y, w, h, {
          roughness: 1.8, stroke: "#22c55e", strokeWidth: 2,
          fill: "#22c55e33", fillStyle: "cross-hatch",
        }));
        const lbl = document.createElementNS("http://www.w3.org/2000/svg", "text");
        lbl.setAttribute("x", String(x + 4));
        lbl.setAttribute("y", String(Math.max(y - 5, 14)));
        lbl.setAttribute("fill", "#22c55e");
        lbl.setAttribute("font-size", "12");
        lbl.setAttribute("font-family", "Patrick Hand, sans-serif");
        lbl.textContent = `✅ Zone ${i + 1}`;
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

        // Selection highlight: blue dashed rect around selected SVG-only element
        if (selectedElemId) {
          const sel = liveElements.find(el => el.id === selectedElemId);
          if (sel && (sel.type === "PRECISION_TARGET" || sel.type === "FREEFORM_ZONE" || sel.type === "DRAWING_STROKE")) {
            let bx, by, bw, bh;
            if (sel.type === "PRECISION_TARGET") {
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
  }, [question?.id, isCreator, revealAnswers, targetJson, drawingRect, drawingPolyline, brushPreview, selectedElemId]); // eslint-disable-line react-hooks/exhaustive-deps

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
      rx: Math.max(0, Math.min(1, cx / rect.width)),   // ratio [0,1]
      ry: Math.max(0, Math.min(1, cy / rect.height)),
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

    // §4 Target-draw loop: capture raw mousedown pixel relative to container
    if (isCreator && creatorMode === "draw-target" && !disabled) {
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) {
        drawStartPx.current = {
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
        };
      }
      return;
    }

    // Freeform-zone: start drag-to-draw (like brush)
    if (isCreator && creatorMode === "draw-freeform" && !disabled) {
      const { rx, ry } = getHitCoords(e.clientX, e.clientY);
      drawingPolylineRef.current = [{ x: rx, y: ry }];
      setDrawingPolyline([{ x: rx, y: ry }]);
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

    // §4 Draw-target live preview: keep in raw-px space, convert to ratios only for display
    if (isCreator && creatorMode === "draw-target" && drawStartPx.current) {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const curPx = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const s     = drawStartPx.current;
      // Convert raw px preview → ratios for SVG overlay (purely visual, not stored yet)
      const minX = Math.min(s.x, curPx.x);
      const minY = Math.min(s.y, curPx.y);
      setDrawingRect({
        x_ratio: Math.max(0, minX / rect.width),
        y_ratio: Math.max(0, minY / rect.height),
        w_ratio: Math.abs(curPx.x - s.x) / rect.width,
        h_ratio: Math.abs(curPx.y - s.y) / rect.height,
      });
      return;
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
    // Capture mouseup raw px, compute MinX/MinY/Width/Height, THEN divide by
    // container size to get final stored ratios. No intermediate pixel storage.
    if (isCreator && creatorMode === "draw-target" && drawStartPx.current) {
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) {
        const s    = drawStartPx.current;
        const ex   = e.clientX - rect.left;
        const ey   = e.clientY - rect.top;
        const minX = Math.min(s.x, ex);
        const minY = Math.min(s.y, ey);
        const w    = Math.abs(ex - s.x);
        const h    = Math.abs(ey - s.y);
        // §2 ratio conversion: divide by live container dimensions (not hardcoded C_W/C_H)
        const x_ratio = Math.max(0, minX / rect.width);
        const y_ratio = Math.max(0, minY / rect.height);
        const w_ratio = Math.min(1 - x_ratio, w / rect.width);
        const h_ratio = Math.min(1 - y_ratio, h / rect.height);
        if (w_ratio > 0.01 && h_ratio > 0.01) {
          // §1 Z-index: append to END of slideElements array (renders on top)
          commitElements([...liveElements, {
            id: randomUUID(),
            type: "PRECISION_TARGET",
            x_ratio, y_ratio, w_ratio, h_ratio,
            isHidden: true,
          }]);
        }
      }
      drawStartPx.current = null;
      setDrawingRect(null);
      return;
    }

    // ── Place TEXT_BLOCK or ANSWER_BLOCK ────────────────────────────────────
    if (isCreator && (creatorMode === "place-text" || creatorMode === "place-answer") && !hasMoved.current) {
      // §3 inverse matrix: undo pan + scale before ratio conversion
      const { rx, ry } = getHitCoords(e.clientX, e.clientY);
      const isAnswer   = creatorMode === "place-answer";
      // §2 ratio conversion + §1 append-to-end
      commitElements([...liveElements, {
        id: randomUUID(),
        type: isAnswer ? "ANSWER_BLOCK" : "TEXT_BLOCK",
        content: isAnswer ? "Move me! 🙈" : "Text Block",
        x_ratio: Math.max(0.01, rx - 0.11),
        y_ratio: Math.max(0.01, ry - 0.05),
        w_ratio: 0.22,
        h_ratio: 0.10,
        fontSizeScale: 1.0,
        isMovableByPlayer: isAnswer,
      }]);
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
      const { rx, ry } = getHitCoords(e.clientX, e.clientY);
      const gaugeEl    = liveElements.find(el => el.type === "GAUGE_BLOCK");
      const gaugeOk    = !gaugeEl ||
        typeof gaugeEl.correctMin !== "number" ||
        (gaugeValue >= gaugeEl.correctMin && gaugeValue <= gaugeEl.correctMax);

      // §1 backwards scan: topmost element wins (highest index = rendered last = on top)
      let hit = false;
      for (let i = liveElements.length - 1; i >= 0; i--) {
        const el = liveElements[i];
        if (el.type === "PRECISION_TARGET") {
          if (
            rx >= el.x_ratio && rx <= el.x_ratio + el.w_ratio &&
            ry >= el.y_ratio && ry <= el.y_ratio + el.h_ratio
          ) { hit = true; break; }
        } else if (el.type === "FREEFORM_ZONE" && el.role === "CORRECT_ANSWER") {
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
    // §2 clamp to [0.01, 0.94] so block never escapes canvas ratio space
    setLiveElements(prev => prev.map(el => el.id !== bd.id ? el : {
      ...el,
      x_ratio: Math.max(0.01, Math.min(1 - el.w_ratio - 0.01, bd.startXR + dx)),
      y_ratio: Math.max(0.01, Math.min(1 - el.h_ratio - 0.01, bd.startYR + dy)),
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

  // ── Clipboard paste: image → IMAGE_BLOCK, text → TEXT_BLOCK ───────────────────
  // Container needs tabIndex so clicking it gives focus, enabling Ctrl+V
  useEffect(() => {
    if (!isCreator) return;
    const container = containerRef.current;
    if (!container) return;
    function handlePaste(e) {
      const items = [...(e.clipboardData?.items ?? [])];
      // Image takes priority over plain text
      const imgItem = items.find(it => it.type.startsWith("image/"));
      if (imgItem) {
        e.preventDefault();
        const blob = imgItem.getAsFile();
        const reader = new FileReader();
        reader.onload = ev => {
          const { rx, ry } = lastClickRef.current;
          const newEl = {
            id: randomUUID(),
            type: "IMAGE_BLOCK",
            src: ev.target.result,
            x_ratio: Math.max(0, Math.min(0.70, rx - 0.15)),
            y_ratio: Math.max(0, Math.min(0.70, ry - 0.10)),
            w_ratio: 0.30,
            h_ratio: 0.20,
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
          const newEl = {
            id: randomUUID(),
            type: "TEXT_BLOCK",
            content: text.trim().slice(0, 200),
            x_ratio: Math.max(0, Math.min(0.78, rx - 0.11)),
            y_ratio: Math.max(0, Math.min(0.90, ry - 0.05)),
            w_ratio: 0.22,
            h_ratio: 0.10,
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

  const cursor = disabled ? "default"
    : isCreator && creatorMode === "draw-target"   ? "crosshair"
    : isCreator && creatorMode === "draw-freeform" ? "crosshair"
    : isCreator && creatorMode === "draw-brush"    ? "crosshair"
    : isCreator && creatorMode === "place-text"    ? "text"
    : isCreator && creatorMode === "place-answer"  ? "cell"
    : "grab";

  const gaugeEl = liveElements.find(el => el.type === "GAUGE_BLOCK");
  // §1 Z-index array: render in forward order (index 0 = bottom, last = top)
  // TEXT_BLOCK, ANSWER_BLOCK, IMAGE_BLOCK rendered as DOM; DRAWING_STROKE in SVG; zones SVG-only
  const domBlocks = liveElements.filter(el =>
    el.type === "TEXT_BLOCK" || el.type === "ANSWER_BLOCK" || el.type === "IMAGE_BLOCK"
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
        maxWidth: isCreator ? "min(100%, calc(100vh - 200px))" : "min(100%, calc(100vh - 280px))",
        margin: "0 auto",
        minHeight: "unset",
      }}
    >
      <div
        ref={containerRef}
        tabIndex={isCreator ? 0 : undefined}
        style={{
          position: "relative",
          width: "100%",
          aspectRatio: "1 / 1",
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
          position: "relative",
          width: "100%",
          height: "100%",
          cursor,
        }}>
        {/* Background SVG layer: rough border and fill */}
        <svg
          ref={bgSvgRef}
          viewBox={`0 0 ${C_W} ${C_H}`}
          preserveAspectRatio="none"
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
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
                : `2.5px solid ${el.type === "ANSWER_BLOCK" ? "#7c3aed" : "#2f2a3c"}`,
              boxShadow: isSelected ? "0 0 0 3px #3b82f640" : undefined,
              borderRadius: el.type === "IMAGE_BLOCK" ? 4 : 10,
              background: el.type === "IMAGE_BLOCK" ? "transparent"
                : el.color
                ? el.color
                : el.type === "ANSWER_BLOCK"
                ? (el.isMovableByPlayer ? "#c8e6ff" : "#ddd6fe")
                : "#ffd7ba",
              padding: el.type === "IMAGE_BLOCK" ? 0 : "5px 8px",
              fontFamily: "Patrick Hand, cursive",
              fontSize: `${(el.fontSizeScale ?? 1.0) * 3}cqw`,
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
              wordBreak: "break-word",
              overflow: (isCreator && creatorMode === "pan") ? "visible" : "hidden",
              display: "flex", alignItems: "center", justifyContent: "center",
              textAlign: "center",
              // IMAGE_BLOCK uses fixed height; text blocks use minHeight to allow wrapping
              ...(el.type === "IMAGE_BLOCK"
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
            {/* Resize handles (8-point) — always visible in pan mode, active when selected */}
            {isCreator && creatorMode === "pan" && (
              <ResizeHandles active={isSelected} onHandleDown={(e, h) => onResizeHandlePointerDown(e, h, el)} />
            )}
            {el.type === "IMAGE_BLOCK" ? (
              <img
                src={el.src}
                alt=""
                draggable={false}
                style={{ width: "100%", height: "100%", objectFit: "contain", display: "block", pointerEvents: "none" }}
              />
            ) : editingTextId === el.id ? (
              /* Inline textarea edit */
              <textarea
                autoFocus
                defaultValue={el.content}
                style={{                  width: "100%", height: "100%", minHeight: 32,
                  border: "none", outline: "none", resize: "none",
                  background: "transparent", fontFamily: "Patrick Hand, cursive",
                  fontSize: `${(el.fontSizeScale ?? 1.0) * 3}cqw`, textAlign: "center", padding: "2px 4px",
                  cursor: "text", boxSizing: "border-box",
                }}
                onPointerDown={e => e.stopPropagation()}
                onChange={e => { editingTextValueRef.current = e.target.value; }}
                onBlur={() => { commitTextEdit(); setEditingTextId(null); }}
              />
            ) : (
              <>
                {el.content}
                {isCreator && el.isMovableByPlayer && (
                  <span style={{ marginLeft: 4, fontSize: "0.7rem", opacity: 0.55, flexShrink: 0 }}>⇕</span>
                )}
              </>
            )}
          </div>
          );
        })}

        {/* Foreground SVG layer: targets, zones, drawings, previews, selection highlights */}
        <svg
          ref={svgRef}
          viewBox={`0 0 ${C_W} ${C_H}`}
          preserveAspectRatio="none"
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 100 }}
        />

        {/* ── Transparent hit-areas for SVG-only elements (creator select mode) ── */}
        {isCreator && liveElements
          .filter(el => el.type === "PRECISION_TARGET" || el.type === "FREEFORM_ZONE" || el.type === "DRAWING_STROKE")
          .map(el => {
            let bx, by, bw, bh;
            if (el.type === "PRECISION_TARGET") {
              bx = el.x_ratio; by = el.y_ratio; bw = el.w_ratio; bh = el.h_ratio;
            } else {
              const pts = el.points_ratio ?? [];
              if (!pts.length) return null;
              const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
              bx = Math.min(...xs); by = Math.min(...ys);
              bw = Math.max(...xs) - bx; bh = Math.max(...ys) - by;
            }
            const PAD = 0.01;
            const ox = Math.max(0, bx - PAD), oy = Math.max(0, by - PAD);
            const ow = Math.min(1 - ox, bw + PAD * 2), oh = Math.min(1 - oy, bh + PAD * 2);
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
                      x: Math.max(0.01, Math.min(0.99, p.x + dx)),
                      y: Math.max(0.01, Math.min(0.99, p.y + dy)),
                    }));
                    setLiveElements(prev => prev.map(x => x.id !== bd.id ? x : { ...x, points_ratio: nextPts }));
                  } else {
                    setLiveElements(prev => prev.map(x => x.id !== bd.id ? x : {
                      ...x,
                      x_ratio: Math.max(0.01, Math.min(1 - x.w_ratio - 0.01, bd.startXR + dx)),
                      y_ratio: Math.max(0.01, Math.min(1 - x.h_ratio - 0.01, bd.startYR + dy)),
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

      {/* GAUGE_BLOCK: outside transform layer so it stays at fixed bottom */}
      {gaugeEl && (
        <div style={{ padding: "8px 14px", borderTop: "2px solid #2f2a3c", background: "#fffdf6" }}>
          <div style={{
            marginBottom: 4, fontFamily: "Patrick Hand, cursive",
            display: "flex", gap: 10, alignItems: "center",
          }}>
            <span>Gauge: <strong>{gaugeValue}</strong></span>
            {(isCreator || revealAnswers) && (
              <span style={{ opacity: 0.6, fontSize: "0.82rem" }}>
                ✅ Correct range: {gaugeEl.correctMin}–{gaugeEl.correctMax}
              </span>
            )}
          </div>
          {/* Ruler-style slider */}
          <div style={{ position: "relative" }}>
            <input
              type="range"
              style={{ width: "100%", accentColor: "#7c3aed" }}
              min={gaugeEl.min ?? 0}
              max={gaugeEl.max ?? 100}
              value={gaugeValue}
              disabled={disabled}
              onChange={e => setGaugeValue(Number(e.target.value))}
            />
            <div style={{
              display: "flex", justifyContent: "space-between",
              fontSize: "0.7rem", opacity: 0.4,
              fontFamily: "Patrick Hand, cursive", marginTop: -2,
            }}>
              <span>{gaugeEl.min ?? 0}</span>
              <span>{Math.round(((gaugeEl.min ?? 0) + (gaugeEl.max ?? 100)) / 2)}</span>
              <span>{gaugeEl.max ?? 100}</span>
            </div>
          </div>
        </div>
      )}

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

