import { describe, it, expect } from "vitest";
import {
  pointInPolygon,
  hitTestQuestion,
  stripAnswersFromQuestion,
  stripAnswersFromQuiz,
  computeRngFactor,
  signPlayerToken,
  verifyPlayerToken,
} from "./game.js";

const SECRET = "test-secret-xyz";

describe("pointInPolygon", () => {
  const sq = [{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}];
  it("inside square", () => expect(pointInPolygon(0.5, 0.5, sq)).toBe(true));
  it("outside square", () => expect(pointInPolygon(1.5, 0.5, sq)).toBe(false));
  it("degenerate < 3 pts", () => expect(pointInPolygon(0.5, 0.5, [{x:0,y:0}])).toBe(false));
});

describe("hitTestQuestion", () => {
  const q = {
    gauge: { enabled: true, min: 0, max: 100, correctMin: 40, correctMax: 60 },
    elements: [
      { type: "PRECISION_TARGET", x_ratio: 0.1, y_ratio: 0.1, w_ratio: 0.2, h_ratio: 0.2 },
      { type: "FREEFORM_ZONE", role: "CORRECT_ANSWER", points_ratio: [{x:0.5,y:0.5},{x:0.9,y:0.5},{x:0.9,y:0.9},{x:0.5,y:0.9}] },
      { type: "FREEFORM_ZONE", role: "DECOY", points_ratio: [{x:0,y:0},{x:0.05,y:0},{x:0.05,y:0.05},{x:0,y:0.05}] },
    ],
  };
  it("hit precision target with valid gauge", () => expect(hitTestQuestion(q, {rx:0.15, ry:0.15}, 50)).toBe(true));
  it("miss when gauge out of range", () => expect(hitTestQuestion(q, {rx:0.15, ry:0.15}, 10)).toBe(false));
  it("miss when gauge missing but required", () => expect(hitTestQuestion(q, {rx:0.15, ry:0.15}, null)).toBe(false));
  it("hit freeform CORRECT_ANSWER", () => expect(hitTestQuestion(q, {rx:0.7, ry:0.7}, 50)).toBe(true));
  it("decoy zone does not count", () => expect(hitTestQuestion(q, {rx:0.02, ry:0.02}, 50)).toBe(false));
  it("rejects out-of-range click", () => expect(hitTestQuestion(q, {rx:1.5, ry:0.5}, 50)).toBe(false));
  it("legacy targetZones fallback works", () => {
    const legacy = { targetZones: [{ xRatio: 0.0, yRatio: 0.0, wRatio: 0.5, hRatio: 0.5 }] };
    expect(hitTestQuestion(legacy, {rx:0.25, ry:0.25}, null)).toBe(true);
    expect(hitTestQuestion(legacy, {rx:0.75, ry:0.75}, null)).toBe(false);
  });
  it("no question / no click => false", () => {
    expect(hitTestQuestion(null, {rx:0.5,ry:0.5}, 50)).toBe(false);
    expect(hitTestQuestion(q, null, 50)).toBe(false);
  });
});

describe("stripAnswersFromQuestion", () => {
  it("removes targetZones, correctMin/Max, PRECISION_TARGET, CORRECT_ANSWER zones; keeps decoys/images", () => {
    const q = {
      id: "q1",
      prompt: "x",
      targetZones: [{xRatio:0,yRatio:0,wRatio:1,hRatio:1}],
      gauge: { enabled: true, min: 0, max: 100, correctMin: 40, correctMax: 60 },
      elements: [
        { type: "PRECISION_TARGET", x_ratio: 0.1, y_ratio: 0.1, w_ratio: 0.2, h_ratio: 0.2 },
        { type: "FREEFORM_ZONE", role: "CORRECT_ANSWER", points_ratio: [] },
        { type: "FREEFORM_ZONE", role: "DECOY", points_ratio: [{x:0,y:0}] },
        { type: "IMAGE", url: "x" },
      ],
    };
    const s = stripAnswersFromQuestion(q);
    expect(s.targetZones).toBeUndefined();
    expect(s.gauge.enabled).toBe(true);
    expect(s.gauge.correctMin).toBeUndefined();
    expect(s.gauge.correctMax).toBeUndefined();
    expect(s.elements.find(e => e.type === "PRECISION_TARGET")).toBeUndefined();
    expect(s.elements.find(e => e.role === "CORRECT_ANSWER")).toBeUndefined();
    expect(s.elements.find(e => e.role === "DECOY")).toBeDefined();
    expect(s.elements.find(e => e.type === "IMAGE")).toBeDefined();
    // original untouched
    expect(q.targetZones).toBeDefined();
    expect(q.gauge.correctMin).toBe(40);
  });
});

describe("stripAnswersFromQuiz", () => {
  it("maps over all questions", () => {
    const quiz = { title: "t", questions: [
      { id: "a", prompt: "p", targetZones: [{xRatio:0,yRatio:0,wRatio:1,hRatio:1}], elements: [] },
      { id: "b", prompt: "p", targetZones: [{xRatio:0,yRatio:0,wRatio:1,hRatio:1}], elements: [] },
    ]};
    const s = stripAnswersFromQuiz(quiz);
    expect(s.questions).toHaveLength(2);
    expect(s.questions[0].targetZones).toBeUndefined();
    expect(s.questions[1].targetZones).toBeUndefined();
  });
});

describe("computeRngFactor", () => {
  it("loss => 1.0", () => expect(computeRngFactor(false)).toBe(1.0));
  it("win => 1.0", () => expect(computeRngFactor(true)).toBe(1.0));
});

describe("player token", () => {
  it("signs and verifies", () => {
    const t = signPlayerToken(SECRET, "ABCD12", "p-1");
    expect(verifyPlayerToken(SECRET, t, "ABCD12", "p-1")).toBe(true);
  });
  it("rejects wrong room", () => {
    const t = signPlayerToken(SECRET, "ABCD12", "p-1");
    expect(verifyPlayerToken(SECRET, t, "ZZZZ99", "p-1")).toBe(false);
  });
  it("rejects wrong player", () => {
    const t = signPlayerToken(SECRET, "ABCD12", "p-1");
    expect(verifyPlayerToken(SECRET, t, "ABCD12", "p-2")).toBe(false);
  });
  it("rejects wrong secret", () => {
    const t = signPlayerToken(SECRET, "ABCD12", "p-1");
    expect(verifyPlayerToken("different-secret", t, "ABCD12", "p-1")).toBe(false);
  });
  it("rejects garbage", () => {
    expect(verifyPlayerToken(SECRET, "not-a-token", "ABCD12", "p-1")).toBe(false);
    expect(verifyPlayerToken(SECRET, null, "ABCD12", "p-1")).toBe(false);
  });
});
