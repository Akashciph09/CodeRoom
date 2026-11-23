import { describe, expect, it } from "vitest";
import {
  DEFAULT_LAYOUT,
  DIVIDER,
  fitLayout,
  isNarrow,
  loadLayout,
  maxSize,
  MIN_SIZE,
  NARROW_BREAKPOINT,
  resizePanel,
  saveLayout,
  STORAGE_KEY,
} from "./roomLayout";

const big = { width: 1400, height: 900 };
const codeWidth = (l: { question: number }, w: number) => w - l.question - 3 * DIVIDER;
const codeHeight = (l: { tests: number }, h: number) => h - l.tests - 3 * DIVIDER;

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
  it("the narrow breakpoint leaves room for the side-by-side minimums", () => {
    expect(NARROW_BREAKPOINT).toBeGreaterThan(MIN_SIZE.question + MIN_SIZE.codeWidth + 3 * DIVIDER);
    expect(isNarrow(NARROW_BREAKPOINT - 1)).toBe(true);
    expect(isNarrow(NARROW_BREAKPOINT)).toBe(false);
  });

  it("keeps a layout that fits unchanged", () => {
    expect(fitLayout(DEFAULT_LAYOUT, big)).toEqual(DEFAULT_LAYOUT);
  });

  it("clamps to leave the editor its minimum width and height, never below the panels' own minimums", () => {
    for (const width of [NARROW_BREAKPOINT, 900, 1200]) {
      for (const height of [300, 500, 800]) {
        const fitted = fitLayout({ question: 3000, tests: 3000 }, { width, height });
        expect(fitted.question).toBeGreaterThanOrEqual(MIN_SIZE.question);
        expect(fitted.tests).toBeGreaterThanOrEqual(MIN_SIZE.tests);
        expect(codeWidth(fitted, width)).toBeGreaterThanOrEqual(MIN_SIZE.codeWidth);
        if (height - 3 * DIVIDER >= MIN_SIZE.tests + MIN_SIZE.codeHeight) {
          expect(codeHeight(fitted, height)).toBeGreaterThanOrEqual(MIN_SIZE.codeHeight);
        }
      }
    }
    expect(fitLayout({ question: 10, tests: 10 }, big)).toEqual({ question: MIN_SIZE.question, tests: MIN_SIZE.tests });
  });

  it("resizes one divider within its limits and saves exactly what is displayed", () => {
    expect(resizePanel(DEFAULT_LAYOUT, "question", 500, big)).toEqual({ question: 500, tests: 300 });
    expect(resizePanel(DEFAULT_LAYOUT, "tests", 50, big).tests).toBe(MIN_SIZE.tests);
    expect(resizePanel(DEFAULT_LAYOUT, "tests", 9999, big).tests).toBe(maxSize("tests", big));

    // In a small window the other size is saved as displayed, so nothing moves on the next render.
    const small = { width: 800, height: 400 };
    const saved = { question: 700, tests: 600 };
    const next = resizePanel(saved, "question", MIN_SIZE.question, small);
    expect(fitLayout(next, small)).toEqual(next);
    expect(next.tests).toBe(fitLayout(saved, small).tests);
  });

  it("loads a saved layout and rejects malformed or out-of-range values", () => {
    expect(loadLayout(memoryStorage(JSON.stringify({ question: 500, tests: 250 })))).toEqual({ question: 500, tests: 250 });
    for (const bad of ["not json", "null", "[]", '{"question":"500","tests":250}', '{"question":10,"tests":250}', '{"question":1e9,"tests":250}', '{"question":500}', '{"question":500,"results":300}']) {
      expect(loadLayout(memoryStorage(bad))).toEqual(DEFAULT_LAYOUT);
    }
    expect(loadLayout(memoryStorage())).toEqual(DEFAULT_LAYOUT);
    expect(loadLayout(undefined)).toEqual(DEFAULT_LAYOUT);
    const throwing = { getItem: () => { throw new Error("blocked"); } };
    expect(loadLayout(throwing)).toEqual(DEFAULT_LAYOUT);
  });

  it("saves non-default layouts and forgets the default one", () => {
    const s = memoryStorage();
    saveLayout({ question: 500, tests: 250 }, s);
    expect(JSON.parse(s.data.get(STORAGE_KEY)!)).toEqual({ question: 500, tests: 250 });
    saveLayout({ ...DEFAULT_LAYOUT }, s);
    expect(s.data.has(STORAGE_KEY)).toBe(false);
    expect(() => saveLayout({ question: 500, tests: 250 }, { setItem: () => { throw new Error("quota"); }, removeItem: () => {} })).not.toThrow();
  });
});
