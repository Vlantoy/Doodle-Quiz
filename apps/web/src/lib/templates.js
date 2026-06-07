export const QUICK_TEMPLATES = [
  {
    id: "tap-the-hidden-star",
    title: "Tap The Hidden Star",
    questions: [
      {
        id: crypto.randomUUID(),
        prompt: "Find and tap the hidden star in the doodle field.",
        canvasImage: "",
        targetZones: [{ xRatio: 0.72, yRatio: 0.62, wRatio: 0.08, hRatio: 0.08 }],
        movableBlocks: [],
        gauge: { enabled: false, min: 0, max: 100, correctMin: 0, correctMax: 100 }
      }
    ]
  },
  {
    id: "gauge-guess",
    title: "Gauge Guess",
    questions: [
      {
        id: crypto.randomUUID(),
        prompt: "Set gauge between 37 and 44.",
        canvasImage: "",
        targetZones: [{ xRatio: 0.2, yRatio: 0.2, wRatio: 0.2, hRatio: 0.2 }],
        movableBlocks: [],
        gauge: { enabled: true, min: 0, max: 100, correctMin: 37, correctMax: 44 }
      }
    ]
  }
];
