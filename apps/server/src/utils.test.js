import { generateGameCode, normalizeCode, randomAvatarSeed } from "./utils.js";

describe("server utils", () => {
  it("creates 6-character alphanumeric codes", () => {
    const code = generateGameCode();
    expect(code).toHaveLength(6);
    expect(code).toMatch(/^[A-Z2-9]+$/);
  });

  it("normalizes room codes to uppercase values", () => {
    expect(normalizeCode(" ab12cd ")).toBe("AB12CD");
    expect(normalizeCode(null)).toBe("");
  });

  it("picks a valid avatar seed", () => {
    const seed = randomAvatarSeed();
    expect(typeof seed).toBe("string");
    expect(seed.length).toBeGreaterThan(0);
  });
});
