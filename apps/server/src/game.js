import { createHmac } from "node:crypto";

// Ray-casting point-in-polygon. points: [{x,y}, ...] in ratio space [0,1].
export function pointInPolygon(px, py, points) {
  if (!Array.isArray(points) || points.length < 3) return false;
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x, yi = points[i].y;
    const xj = points[j].x, yj = points[j].y;
    const denom = (yj - yi) || 1e-12;
    const intersect = ((yi > py) !== (yj > py)) &&
      (px < ((xj - xi) * (py - yi)) / denom + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// Authoritative hit-test. question = raw question from quiz_payload (has answers).
// click = { rx, ry } in [0,1]. gaugeValue may be null.
export function hitTestQuestion(question, click, gaugeValue) {
  if (!question || !click) return false;
  const { rx, ry } = click;
  if (typeof rx !== "number" || typeof ry !== "number") return false;
  if (rx < 0 || rx > 1 || ry < 0 || ry > 1) return false;

  const g = question.gauge;
  if (g && g.enabled) {
    if (typeof gaugeValue !== "number") return false;
    if (gaugeValue < g.correctMin || gaugeValue > g.correctMax) return false;
  }

  const elements = Array.isArray(question.elements) ? question.elements : [];
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    if (!el || typeof el !== "object") continue;
    if (el.type === "PRECISION_TARGET") {
      if (rx >= el.x_ratio && rx <= el.x_ratio + el.w_ratio &&
          ry >= el.y_ratio && ry <= el.y_ratio + el.h_ratio) return true;
    } else if (el.type === "FREEFORM_ZONE" && el.role === "CORRECT_ANSWER") {
      if (pointInPolygon(rx, ry, el.points_ratio)) return true;
    }
  }

  const zones = Array.isArray(question.targetZones) ? question.targetZones : [];
  for (const z of zones) {
    if (rx >= z.xRatio && rx <= z.xRatio + z.wRatio &&
        ry >= z.yRatio && ry <= z.yRatio + z.hRatio) return true;
  }

  return false;
}

// Remove answer-revealing fields before shipping a quiz/question to clients.
export function stripAnswersFromQuestion(q) {
  if (!q) return q;
  const stripped = { ...q };
  delete stripped.targetZones;
  if (q.gauge) {
    stripped.gauge = {
      enabled: q.gauge.enabled,
      min: q.gauge.min,
      max: q.gauge.max,
      // correctMin / correctMax intentionally omitted
    };
  }
  if (Array.isArray(q.elements)) {
    stripped.elements = q.elements
      .map(el => {
        if (!el || typeof el !== "object") return el;
        if (el.type === "PRECISION_TARGET") return null;
        if (el.type === "FREEFORM_ZONE" && el.role === "CORRECT_ANSWER") return null;
        return el;
      })
      .filter(Boolean);
  }
  return stripped;
}

export function stripAnswersFromQuiz(quiz) {
  if (!quiz || !Array.isArray(quiz.questions)) return quiz;
  return { ...quiz, questions: quiz.questions.map(stripAnswersFromQuestion) };
}

// RNG: win => 1.0, loss => 1.0 (RR 1:1)
export function computeRngFactor(isWin) {
  return 1.0;
}

// HMAC player token: roomCode|playerId|sig
export function signPlayerToken(secret, roomCode, playerId) {
  const payload = `${roomCode}|${playerId}`;
  const sig = createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}|${sig}`;
}

export function verifyPlayerToken(secret, token, roomCode, playerId) {
  if (typeof token !== "string") return false;
  const parts = token.split("|");
  if (parts.length !== 3) return false;
  const [r, p, sig] = parts;
  if (r !== roomCode || p !== playerId) return false;
  const expected = createHmac("sha256", secret).update(`${r}|${p}`).digest("hex");
  if (sig.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
