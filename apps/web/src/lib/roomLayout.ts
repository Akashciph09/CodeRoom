/**
 * Layout math for the room's three columns (question | editor | results). Pure functions, unit tested;
 * the component in `components/RoomLayout.tsx` only wires them to pointer/keyboard events (ADR 0008).
 *
 * Sizes are pixels. The editor always takes what's left, and never less than `MIN_WIDTH.editor`.
 * A saved layout is a *preference*: when the window is too small it is shown clamped (`fitLayout`)
 * but not rewritten, so it comes back when the window grows again. An explicit resize saves what is
 * on screen (`resizePanel`), so the panel the user didn't touch never moves.
 */

export type SidePanel = "question" | "results";

export interface RoomLayout {
  question: number;
  results: number;
}

export const DEFAULT_LAYOUT: Readonly<RoomLayout> = { question: 320, results: 360 };
export const MIN_WIDTH = { question: 220, editor: 320, results: 260 } as const;
/** Width of each draggable divider (two of them). */
export const DIVIDER_WIDTH = 6;
/** Below this room width the columns become tabs. Must exceed the sum of minimums + dividers (812). */
export const NARROW_BREAKPOINT = 900;
/** Keyboard step for the separators; Shift multiplies it. */
export const KEY_STEP = 16;
export const KEY_STEP_LARGE = 64;

export const STORAGE_KEY = "coderoom:room-layout:v1";

const other = (panel: SidePanel): SidePanel => (panel === "question" ? "results" : "question");
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

export const isNarrow = (width: number) => width < NARROW_BREAKPOINT;

/** Space the two side panels can share at this room width. */
const sideBudget = (width: number) => width - 2 * DIVIDER_WIDTH - MIN_WIDTH.editor;

/**
 * The layout to *display* at this width: each side panel at least its minimum, and together small
 * enough to leave the editor its minimum. When they must shrink, each gives up space in proportion
 * to how far it is above its own minimum.
 */
export function fitLayout(layout: RoomLayout, width: number): RoomLayout {
  const q = Math.max(Math.round(layout.question), MIN_WIDTH.question);
  const r = Math.max(Math.round(layout.results), MIN_WIDTH.results);
  const overflow = q + r - sideBudget(width);
  if (overflow <= 0) return { question: q, results: r };

  const qSlack = q - MIN_WIDTH.question;
  const rSlack = r - MIN_WIDTH.results;
  const slack = qSlack + rSlack;
  if (slack <= overflow) return { question: MIN_WIDTH.question, results: MIN_WIDTH.results };
  const qCut = Math.round((overflow * qSlack) / slack);
  return { question: q - qCut, results: r - (overflow - qCut) };
}

/** Largest width `panel` may take at this room width, given the other panel's displayed width. */
export function maxWidth(panel: SidePanel, layout: RoomLayout, width: number): number {
  const fitted = fitLayout(layout, width);
  return Math.max(MIN_WIDTH[panel], sideBudget(width) - fitted[other(panel)]);
}

/**
 * The layout to save after the user sets one side panel's width: that panel clamped to its minimum and
 * to what the room can fit, and the *other* panel pinned at the width it is displayed at now.
 *
 * Both panels are saved as displayed, never "the new width + the other's old preference": when the
 * window is too small for the saved preferences, mixing a displayed width with an oversized preference
 * would be re-fitted on the next render and visibly move the panel the user didn't touch. The result
 * always fits at this width (`fitLayout(result, width)` returns it unchanged).
 */
export function resizePanel(layout: RoomLayout, panel: SidePanel, size: number, width: number): RoomLayout {
  const fitted = fitLayout(layout, width);
  return { ...fitted, [panel]: Math.round(clamp(size, MIN_WIDTH[panel], maxWidth(panel, layout, width))) };
}

export const isDefaultLayout = (layout: RoomLayout) =>
  layout.question === DEFAULT_LAYOUT.question && layout.results === DEFAULT_LAYOUT.results;

/** Read the saved layout; anything missing, malformed or out of range falls back to the default. */
export function loadLayout(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): RoomLayout {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_LAYOUT };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { ...DEFAULT_LAYOUT };
    const { question, results } = parsed as Record<string, unknown>;
    const valid = (v: unknown, min: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= min && v <= 4000;
    if (!valid(question, MIN_WIDTH.question) || !valid(results, MIN_WIDTH.results)) return { ...DEFAULT_LAYOUT };
    return { question: Math.round(question), results: Math.round(results) };
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
