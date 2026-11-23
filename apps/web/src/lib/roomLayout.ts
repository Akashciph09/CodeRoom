/**
 * Layout math for the room (ADR 0008): the question on the left, and on the right the code editor
 * stacked over the test panel (Testcase / Test Result). Two sizes are user-adjustable:
 *  - `question` — width of the question column (vertical divider);
 *  - `tests`    — height of the test panel (horizontal divider).
 * Pure functions, unit tested; `components/RoomLayout.tsx` only wires them to pointer/keyboard events.
 *
 * Sizes are pixels. The editor always takes what's left, and never less than its minimum width/height.
 * A saved layout is a *preference*: when the window is too small it is shown clamped (`fitLayout`)
 * but not rewritten, so it comes back when the window grows again. An explicit resize saves what is
 * on screen (`resizePanel`).
 */

export type Divider = "question" | "tests";

export interface RoomLayout {
  question: number;
  tests: number;
}

/** Size of the area the layout is fitted into (the room below the top bar). */
export interface Area {
  width: number;
  height: number;
}

export const DEFAULT_LAYOUT: Readonly<RoomLayout> = { question: 420, tests: 300 };
export const MIN_SIZE = { question: 260, codeWidth: 380, codeHeight: 160, tests: 140 } as const;
/** Thickness of a divider, and of the gap around the cards. */
export const DIVIDER = 6;
/** Below this room width the panels become tabs. Must exceed the side-by-side minimums (664). */
export const NARROW_BREAKPOINT = 768;
/** Keyboard step for the dividers; Shift multiplies it. */
export const KEY_STEP = 16;
export const KEY_STEP_LARGE = 64;

export const STORAGE_KEY = "coderoom:room-layout:v2";

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), Math.max(lo, hi));

export const isNarrow = (width: number) => width < NARROW_BREAKPOINT;

/**
 * Largest size a divider may give its panel in this area (never below the panel's minimum).
 * Each axis has the outer gap on both sides plus the divider itself: 3 × DIVIDER.
 */
export function maxSize(divider: Divider, area: Area): number {
  return divider === "question"
    ? Math.max(MIN_SIZE.question, area.width - 3 * DIVIDER - MIN_SIZE.codeWidth)
    : Math.max(MIN_SIZE.tests, area.height - 3 * DIVIDER - MIN_SIZE.codeHeight);
}

/** The layout to *display* in this area: each size within its minimum and what leaves the editor its minimum. */
export function fitLayout(layout: RoomLayout, area: Area): RoomLayout {
  return {
    question: Math.round(clamp(layout.question, MIN_SIZE.question, maxSize("question", area))),
    tests: Math.round(clamp(layout.tests, MIN_SIZE.tests, maxSize("tests", area))),
  };
}

/**
 * The layout to save after the user sets one divider: that size clamped, and the other size pinned at
 * what is displayed now — what's saved is exactly what's on screen (`fitLayout(result) === result`).
 */
export function resizePanel(layout: RoomLayout, divider: Divider, size: number, area: Area): RoomLayout {
  const fitted = fitLayout(layout, area);
  return { ...fitted, [divider]: Math.round(clamp(size, MIN_SIZE[divider], maxSize(divider, area))) };
}

export const isDefaultLayout = (layout: RoomLayout) =>
  layout.question === DEFAULT_LAYOUT.question && layout.tests === DEFAULT_LAYOUT.tests;

/** Read the saved layout; anything missing, malformed or out of range falls back to the default. */
export function loadLayout(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): RoomLayout {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_LAYOUT };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { ...DEFAULT_LAYOUT };
    const { question, tests } = parsed as Record<string, unknown>;
    const valid = (v: unknown, min: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= min && v <= 4000;
    if (!valid(question, MIN_SIZE.question) || !valid(tests, MIN_SIZE.tests)) return { ...DEFAULT_LAYOUT };
    return { question: Math.round(question), tests: Math.round(tests) };
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

/** Best effort: private windows and blocked storage just mean the layout isn't remembered. */
export function saveLayout(layout: RoomLayout, storage: Pick<Storage, "setItem" | "removeItem"> | undefined = safeStorage()) {
  try {
    if (isDefaultLayout(layout)) storage?.removeItem(STORAGE_KEY);
    else storage?.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    /* not remembered — fine */
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}
