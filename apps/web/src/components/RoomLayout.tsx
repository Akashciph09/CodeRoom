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
  DIVIDER_WIDTH,
  fitLayout,
  isDefaultLayout,
  isNarrow,
  KEY_STEP,
  KEY_STEP_LARGE,
  loadLayout,
  maxWidth,
  MIN_WIDTH,
  resizePanel,
  saveLayout,
  type RoomLayout,
  type SidePanel,
} from "../lib/roomLayout";

/**
 * The room's column layout, local to this browser (ADR 0008). Never synced through Yjs/awareness:
 * each participant sizes their own screen.
 */
export function useRoomLayout() {
  // A callback ref, not useRef: the container mounts only once the room has loaded, after this hook's
  // first render, so the observer must attach whenever the element appears.
  const [container, containerRef] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(() => (typeof window === "undefined" ? 1280 : window.innerWidth));
  const [saved, setSavedState] = useState<RoomLayout>(() => loadLayout());
  const savedRef = useRef(saved);

  const setSaved = useCallback((next: RoomLayout) => {
    savedRef.current = next;
    setSavedState(next);
  }, []);

  useLayoutEffect(() => {
    if (!container) return;
    setWidth(container.clientWidth);
    const observer = new ResizeObserver(() => setWidth(container.clientWidth));
    observer.observe(container);
    return () => observer.disconnect();
  }, [container]);

  /** Resize one panel. Only that panel's preference changes; the other keeps its saved value. */
  const resize = useCallback(
    (panel: SidePanel, size: number) => {
      const next = resizePanel(savedRef.current, panel, size, width);
      if (next[panel] !== savedRef.current[panel]) setSaved({ ...savedRef.current, [panel]: next[panel] });
    },
    [width, setSaved],
  );
  const commit = useCallback(() => saveLayout(savedRef.current), []);
  const reset = useCallback(() => {
    setSaved({ ...DEFAULT_LAYOUT });
    saveLayout(DEFAULT_LAYOUT);
  }, [setSaved]);
  const resetPanel = useCallback(
    (panel: SidePanel) => {
      setSaved({ ...savedRef.current, [panel]: DEFAULT_LAYOUT[panel] });
      saveLayout(savedRef.current);
    },
    [setSaved],
  );

  return {
    containerRef,
    width,
    narrow: isNarrow(width),
    displayed: fitLayout(saved, width),
    saved,
    isDefault: isDefaultLayout(saved),
    resize,
    commit,
    reset,
    resetPanel,
  };
}

export type RoomLayoutState = ReturnType<typeof useRoomLayout>;

type Tab = "question" | "code" | "results";
const TABS: { id: Tab; label: string }[] = [
  { id: "question", label: "Question" },
  { id: "code", label: "Code" },
  { id: "results", label: "Results" },
];

interface Props {
  layout: RoomLayoutState;
  question: ReactNode;
  editor: ReactNode;
  results: ReactNode;
  /** Changes whenever results change; on narrow screens it marks the Results tab as unseen. */
  resultsKey: string;
}

/**
 * Three columns with draggable separators; tabs on narrow screens. All three columns are always
 * rendered, in the same positions, in every mode: switching modes or resizing only changes CSS, so
 * the editor (Monaco + its Yjs binding) is never remounted.
 */
export function RoomColumns({ layout, question, editor, results, resultsKey }: Props) {
  const { containerRef, narrow, displayed, width } = layout;
  const [tab, setTab] = useState<Tab>("code");
  const [unseen, setUnseen] = useState(false);

  const firstResults = useRef(resultsKey);
  useEffect(() => {
    if (resultsKey === firstResults.current) return;
    firstResults.current = resultsKey;
    if (narrow && tab !== "results") setUnseen(true);
    // Only react to new results, not to tab/mode changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resultsKey]);
  useEffect(() => {
    if (tab === "results" || !narrow) setUnseen(false);
  }, [tab, narrow]);

  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ question: null, code: null, results: null });
  function onTabKey(e: KeyboardEvent) {
    const i = TABS.findIndex((t) => t.id === tab);
    const next =
      e.key === "ArrowRight" ? TABS[(i + 1) % TABS.length] : e.key === "ArrowLeft" ? TABS[(i + TABS.length - 1) % TABS.length] : e.key === "Home" ? TABS[0] : e.key === "End" ? TABS[TABS.length - 1] : null;
    if (!next) return;
    e.preventDefault();
    setTab(next.id);
    tabRefs.current[next.id]?.focus();
  }

  const column = (id: Tab, content: ReactNode) => (
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
      style={
        narrow
          ? undefined
          : { gridTemplateColumns: `${displayed.question}px ${DIVIDER_WIDTH}px minmax(0, 1fr) ${DIVIDER_WIDTH}px ${displayed.results}px` }
      }
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
              {t.id === "results" && unseen && (
                <>
                  <span className="unseen-dot" aria-hidden="true" />
                  <span className="sr-only"> (new)</span>
                </>
              )}
            </button>
          ))}
        </div>
      )}
      {column("question", question)}
      {!narrow && <Separator panel="question" label="Resize question panel" layout={layout} max={maxWidth("question", layout.saved, width)} />}
      {column("code", editor)}
      {!narrow && <Separator panel="results" label="Resize results panel" layout={layout} max={maxWidth("results", layout.saved, width)} />}
      {column("results", results)}
    </div>
  );
}

/**
 * WAI-ARIA window splitter. Its value is the width of the side panel it controls. Drag with the
 * pointer, or focus it and use ←/→ (Shift = larger steps) and Home/End; double-click resets the panel.
 * The separator sits on the panel's inner edge, so for the results panel moving right shrinks it.
 */
function Separator({ panel, label, layout, max }: { panel: SidePanel; label: string; layout: RoomLayoutState; max: number }) {
  const value = layout.displayed[panel];
  const min = MIN_WIDTH[panel];
  const direction = panel === "question" ? 1 : -1;
  const drag = useRef<{ x: number; start: number } | null>(null);

  function end() {
    if (!drag.current) return;
    drag.current = null;
    document.body.classList.remove("resizing");
    layout.commit();
  }

  return (
    <div
      className="splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={`room-col-${panel}`}
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
        drag.current = { x: e.clientX, start: value };
        document.body.classList.add("resizing");
      }}
      onPointerMove={(e) => {
        if (drag.current) layout.resize(panel, drag.current.start + direction * (e.clientX - drag.current.x));
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={() => layout.resetPanel(panel)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
        let next: number;
        if (e.key === "ArrowRight") next = value + direction * step;
        else if (e.key === "ArrowLeft") next = value - direction * step;
        else if (e.key === "Home") next = min;
        else if (e.key === "End") next = max;
        else return;
        e.preventDefault();
        layout.resize(panel, next);
        layout.commit();
      }}
    />
  );
}
