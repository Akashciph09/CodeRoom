import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  DEFAULT_LAYOUT,
  DIVIDER,
  fitLayout,
  isDefaultLayout,
  isNarrow,
  KEY_STEP,
  KEY_STEP_LARGE,
  loadLayout,
  maxSize,
  MIN_SIZE,
  resizePanel,
  saveLayout,
  type Area,
  type Divider,
  type RoomLayout,
} from "../lib/roomLayout";

/**
 * The room's layout, local to this browser (ADR 0008). Never synced through Yjs/awareness: each
 * participant sizes their own screen.
 */
export function useRoomLayout() {
  // A callback ref, not useRef: the container mounts only once the room has loaded, after this hook's
  // first render, so the observer must attach whenever the element appears.
  const [container, containerRef] = useState<HTMLDivElement | null>(null);
  const [area, setArea] = useState<Area>(() =>
    typeof window === "undefined" ? { width: 1280, height: 720 } : { width: window.innerWidth, height: window.innerHeight - 52 },
  );
  const [saved, setSavedState] = useState<RoomLayout>(() => loadLayout());
  const savedRef = useRef(saved);

  const setSaved = useCallback((next: RoomLayout) => {
    savedRef.current = next;
    setSavedState(next);
  }, []);

  useLayoutEffect(() => {
    if (!container) return;
    const measure = () => setArea({ width: container.clientWidth, height: container.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [container]);

  /** Set one divider. Saves both sizes as displayed (see `resizePanel`), so the other never moves. */
  const resize = useCallback(
    (divider: Divider, size: number) => {
      const next = resizePanel(savedRef.current, divider, size, area);
      const current = savedRef.current;
      if (next.question !== current.question || next.tests !== current.tests) setSaved(next);
    },
    [area, setSaved],
  );
  const commit = useCallback(() => saveLayout(savedRef.current), []);
  const reset = useCallback(() => {
    setSaved({ ...DEFAULT_LAYOUT });
    saveLayout(DEFAULT_LAYOUT);
  }, [setSaved]);
  /** Double-click a divider: that size back to its default (as far as it fits). */
  const resetDivider = useCallback(
    (divider: Divider) => {
      setSaved(resizePanel(savedRef.current, divider, DEFAULT_LAYOUT[divider], area));
      saveLayout(savedRef.current);
    },
    [area, setSaved],
  );

  return {
    containerRef,
    area,
    narrow: isNarrow(area.width),
    displayed: fitLayout(saved, area),
    saved,
    isDefault: isDefaultLayout(saved),
    resize,
    commit,
    reset,
    resetDivider,
  };
}

export type RoomLayoutState = ReturnType<typeof useRoomLayout>;

type Tab = "question" | "code" | "tests";
const TABS: { id: Tab; label: string }[] = [
  { id: "question", label: "Question" },
  { id: "code", label: "Code" },
  { id: "tests", label: "Tests" },
];

interface Props {
  layout: RoomLayoutState;
  question: ReactNode;
  code: ReactNode;
  tests: ReactNode;
  runNavigation: number;
  /** Changes when the latest Run changes so narrow layouts can mark the Tests tab as unseen. */
  resultsKey: string;
}

/**
 * Question | Code over Tests, with draggable dividers; tabs on narrow screens. Every panel is always
 * rendered, in the same position, in every mode: switching modes or resizing only changes CSS, so the
 * editor (Monaco + its Yjs binding) is never remounted.
 */
export function RoomColumns({ layout, question, code, tests, resultsKey, runNavigation }: Props) {
  const { containerRef, narrow, displayed, area } = layout;
  const [tab, setTab] = useState<Tab>("code");
  const [unseen, setUnseen] = useState(false);

  useEffect(() => {
    if (runNavigation > 0) setTab("tests");
  }, [runNavigation]);

  const firstResults = useRef(resultsKey);
  useEffect(() => {
    if (resultsKey === firstResults.current) return;
    firstResults.current = resultsKey;
    if (narrow && tab !== "tests") setUnseen(true);
    // Only react to new results, not to tab/mode changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resultsKey]);
  useEffect(() => {
    if (tab === "tests" || !narrow) setUnseen(false);
  }, [tab, narrow]);

  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ question: null, code: null, tests: null });
  function onTabKey(e: KeyboardEvent) {
    const i = TABS.findIndex((t) => t.id === tab);
    const next =
      e.key === "ArrowRight" ? TABS[(i + 1) % TABS.length] : e.key === "ArrowLeft" ? TABS[(i + TABS.length - 1) % TABS.length] : e.key === "Home" ? TABS[0] : e.key === "End" ? TABS[TABS.length - 1] : null;
    if (!next) return;
    e.preventDefault();
    setTab(next.id);
    tabRefs.current[next.id]?.focus();
  }

  const pane = (id: Tab, content: ReactNode) => (
    <div
      className={`room-col room-col-${id}`}
      id={`room-col-${id}`}
      role={narrow ? "tabpanel" : undefined}
      aria-labelledby={narrow ? `room-tab-${id}` : undefined}
      hidden={narrow && tab !== id}
    >
      {content}
    </div>
  );

  return (
    <div
      ref={containerRef}
      className={`room-layout ${narrow ? "narrow" : "wide"}`}
      style={narrow ? undefined : { gridTemplateColumns: `${displayed.question}px ${DIVIDER}px minmax(0, 1fr)` }}
    >
      {narrow && (
        <div className="room-tabs tabs" role="tablist" aria-label="Room panels" onKeyDown={onTabKey}>
          {TABS.map((t) => (
            <button
              key={t.id}
              ref={(el) => {
                tabRefs.current[t.id] = el;
              }}
              id={`room-tab-${t.id}`}
              role="tab"
              aria-selected={tab === t.id}
              aria-controls={`room-col-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              className={tab === t.id ? "active" : undefined}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {t.id === "tests" && unseen && (
                <>
                  <span className="unseen-dot" aria-hidden="true" />
                  <span className="sr-only"> (new)</span>
                </>
              )}
            </button>
          ))}
        </div>
      )}
      {pane("question", question)}
      {!narrow && (
        <Separator divider="question" label="Resize question panel" layout={layout} max={maxSize("question", area)} />
      )}
      <div
        className="room-right"
        style={narrow ? undefined : { gridTemplateRows: `minmax(0, 1fr) ${DIVIDER}px ${displayed.tests}px` }}
      >
        {pane("code", code)}
        {!narrow && <Separator divider="tests" label="Resize test panel" layout={layout} max={maxSize("tests", area)} />}
        {pane("tests", tests)}
      </div>
    </div>
  );
}

/**
 * WAI-ARIA window splitter. Its value is the size of the panel it controls: the question column's
 * width (vertical divider) or the test panel's height (horizontal divider, below the editor — so
 * dragging/arrowing it *up* makes the test panel taller). Drag with the pointer, or focus it and use
 * the arrow keys (Shift = larger steps) and Home/End; double-click resets it.
 */
function Separator({ divider, label, layout, max }: { divider: Divider; label: string; layout: RoomLayoutState; max: number }) {
  const value = layout.displayed[divider];
  const min = MIN_SIZE[divider];
  const vertical = divider === "question";
  const drag = useRef<{ at: number; start: number } | null>(null);
  const pos = (e: PointerEvent) => (vertical ? e.clientX : e.clientY);

  function end() {
    if (!drag.current) return;
    drag.current = null;
    document.body.classList.remove("resizing", "resizing-row");
    layout.commit();
  }

  return (
    <div
      className={`splitter ${vertical ? "splitter-col" : "splitter-row"}`}
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-label={label}
      aria-controls={`room-col-${vertical ? "question" : "tests"}`}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuetext={`${value} pixels`}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={(e: PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        e.preventDefault(); // don't move focus out of the editor or start a text selection
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { at: pos(e), start: value };
        document.body.classList.add(vertical ? "resizing" : "resizing-row");
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const delta = pos(e) - drag.current.at;
        layout.resize(divider, drag.current.start + (vertical ? delta : -delta));
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={() => layout.resetDivider(divider)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
        const grow = vertical ? "ArrowRight" : "ArrowUp";
        const shrink = vertical ? "ArrowLeft" : "ArrowDown";
        let next: number;
        if (e.key === grow) next = value + step;
        else if (e.key === shrink) next = value - step;
        else if (e.key === "Home") next = min;
        else if (e.key === "End") next = max;
        else return;
        e.preventDefault();
        layout.resize(divider, next);
        layout.commit();
      }}
    />
  );
}
