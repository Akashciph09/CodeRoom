import { describe, expect, it } from "vitest";
import {
  DEFAULT_LAYOUT,
  DIVIDER_WIDTH,
  fitLayout,
  isNarrow,
  loadLayout,
  maxWidth,
  MIN_WIDTH,
  NARROW_BREAKPOINT,
  resizePanel,
  saveLayout,
  STORAGE_KEY,
} from "./roomLayout";

const editorWidth = (l: { question: number; results: number }, width: number) =>
  width - l.question - l.results - 2 * DIVIDER_WIDTH;

function memoryStorage(initial?: string) {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(STORAGE_KEY, initial);
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

describe("room layout", () => {
  it("the narrow breakpoint leaves room for every minimum", () => {
    expect(NARROW_BREAKPOINT).toBeGreaterThan(MIN_WIDTH.question + MIN_WIDTH.editor + MIN_WIDTH.results + 2 * DIVIDER_WIDTH);
    expect(isNarrow(NARROW_BREAKPOINT - 1)).toBe(true);
    expect(isNarrow(NARROW_BREAKPOINT)).toBe(false);
  });

  it("keeps a layout that fits unchanged", () => {
    expect(fitLayout(DEFAULT_LAYOUT, 1400)).toEqual(DEFAULT_LAYOUT);
  });

  it("shrinks side panels to leave the editor its minimum, never below their own minimums", () => {
    const wide = { question: 600, results: 600 };
    for (const width of [NARROW_BREAKPOINT, 1000, 1200, 1500]) {
      const fitted = fitLayout(wide, width);
      expect(fitted.question).toBeGreaterThanOrEqual(MIN_WIDTH.question);
      expect(fitted.results).toBeGreaterThanOrEqual(MIN_WIDTH.results);
      expect(editorWidth(fitted, width)).toBeGreaterThanOrEqual(MIN_WIDTH.editor);
    }
    // Shrinks in proportion to each panel's slack above its minimum.
    const fitted = fitLayout({ question: 420, results: 260 }, 1000);
    expect(fitted.results).toBe(260);
    expect(editorWidth(fitted, 1000)).toBe(MIN_WIDTH.editor);
  });

  it("raises below-minimum values to the minimum", () => {
    expect(fitLayout({ question: 10, results: 10 }, 1400)).toEqual({ question: MIN_WIDTH.question, results: MIN_WIDTH.results });
  });

  it("resizes one panel within its minimum and the editor's minimum", () => {
    expect(resizePanel(DEFAULT_LAYOUT, "question", 400, 1400)).toEqual({ question: 400, results: 360 });
    expect(resizePanel(DEFAULT_LAYOUT, "question", 50, 1400).question).toBe(MIN_WIDTH.question);
    const maxed = resizePanel(DEFAULT_LAYOUT, "results", 5000, 1400);
    expect(maxed.question).toBe(320);
    expect(editorWidth(maxed, 1400)).toBe(MIN_WIDTH.editor);
  });

  it("the 900px report: Home on the question divider doesn't grow the results panel", () => {
    const shown = fitLayout(DEFAULT_LAYOUT, 900);
    expect(shown).toEqual({ question: 264, results: 304 });
    const next = resizePanel(DEFAULT_LAYOUT, "question", MIN_WIDTH.question, 900);
    expect(fitLayout(next, 900)).toEqual({ question: 220, results: 304 });
  });

  it("resizing one panel never moves the other, even when saved preferences don't fit (900–1000px)", () => {
    const preferences = [
      { ...DEFAULT_LAYOUT },
      { question: 600, results: 600 },
      { question: 700, results: 260 },
      { question: 220, results: 700 },
      { question: 500, results: 380 },
    ];
    for (let width = 900; width <= 1000; width += 10) {
      for (const saved of preferences) {
        for (const panel of ["question", "results"] as const) {
          const otherPanel = panel === "question" ? "results" : "question";
          const before = fitLayout(saved, width);
          const max = maxWidth(panel, saved, width);
          for (const size of [0, MIN_WIDTH[panel], before[panel] - 16, before[panel] + 16, (MIN_WIDTH[panel] + max) / 2, max, 5000, DEFAULT_LAYOUT[panel]]) {
            const next = resizePanel(saved, panel, size, width);
            const shown = fitLayout(next, width);
            const at = `width ${width}, saved ${JSON.stringify(saved)}, ${panel} → ${size}`;
            expect(shown[otherPanel], at).toBe(before[otherPanel]); // the other panel didn't move
            expect(shown, at).toEqual(next); // what's saved is exactly what's shown (no re-fit on next render)
            expect(shown[panel], at).toBeGreaterThanOrEqual(MIN_WIDTH[panel]);
            expect(shown[panel], at).toBeLessThanOrEqual(max);
            expect(editorWidth(shown, width), at).toBeGreaterThanOrEqual(MIN_WIDTH.editor);
          }
        }
      }
    }
  });

  it("loads a saved layout and rejects malformed or out-of-range values", () => {
    expect(loadLayout(memoryStorage(JSON.stringify({ question: 400, results: 300 })))).toEqual({ question: 400, results: 300 });
    for (const bad of ["not json", "null", "[]", '{"question":"400","results":300}', '{"question":10,"results":300}', '{"question":1e9,"results":300}', '{"question":400}']) {
      expect(loadLayout(memoryStorage(bad))).toEqual(DEFAULT_LAYOUT);
    }
    expect(loadLayout(memoryStorage())).toEqual(DEFAULT_LAYOUT);
    expect(loadLayout(undefined)).toEqual(DEFAULT_LAYOUT);
    const throwing = { getItem: () => { throw new Error("blocked"); } };
    expect(loadLayout(throwing)).toEqual(DEFAULT_LAYOUT);
  });

  it("saves non-default layouts and forgets the default one", () => {
    const s = memoryStorage();
    saveLayout({ question: 400, results: 300 }, s);
    expect(JSON.parse(s.data.get(STORAGE_KEY)!)).toEqual({ question: 400, results: 300 });
    saveLayout({ ...DEFAULT_LAYOUT }, s);
    expect(s.data.has(STORAGE_KEY)).toBe(false);
    expect(() => saveLayout({ question: 400, results: 300 }, { setItem: () => { throw new Error("quota"); }, removeItem: () => {} })).not.toThrow();
  });
});
