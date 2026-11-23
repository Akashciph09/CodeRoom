# 0008 — Resizable room panels: own splitter, layout kept per browser

**Status:** Accepted — implemented (`apps/web/src/lib/roomLayout.ts`, `components/RoomLayout.tsx`)

## Context
The room has three columns: question, shared editor, results. People read long statements or long test output, so a fixed split doesn't suit everyone. Resizing must never disturb the shared editor: Monaco is bound to the room's Yjs text through `y-monaco`, and remounting it would tear down the binding (losing cursor, selection and undo history) mid-interview.

## Decision
- **Our own splitter**, about 150 lines: pure, unit-tested layout math (`roomLayout.ts`: clamping, minimums, fitting into the window) plus a small component that renders the separators.
- **Sizes in pixels with pixel minimums** (question 220, editor 320, results 260). The editor takes the remaining space (`minmax(0, 1fr)`). Saved sizes are *preferences*: a smaller window shows them clamped but doesn't overwrite them, so the layout comes back when the window grows again. **A resize saves both panels as displayed** — the dragged one at its new width, the other pinned where it is. Saving the new width next to the other panel's oversized preference would be re-fitted on the next render and move the panel the user didn't touch (at 900 px, Home on the question divider used to grow results from 304 to 348 px). The trade-off: after an explicit resize in a squeezed window, the untouched panel's larger preference is replaced by its visible width.
- **Accessible separators** following the WAI-ARIA window-splitter pattern: `role="separator"`, `aria-valuenow/min/max`, `aria-controls`, focusable. Arrow keys move 16 px (Shift: 64 px), Home/End go to the minimum/maximum, and a double click resets that panel.
- **One DOM tree in every mode.** Wide, narrow and resized layouts only change CSS (grid columns, `hidden`); the editor element is never unmounted or moved. Monaco's `automaticLayout` (a ResizeObserver) re-lays the editor out when its column changes size, including when it becomes visible again.
- **Narrow screens (< 900 px of room width) use tabs:** Question / Code / Results. Results shows a dot when a result arrives on another tab. The breakpoint is above the sum of the minimums (812 px), so three columns are never squeezed below them.
- **Layout is local to each participant.** It's stored in `localStorage` (`coderoom:room-layout:v1`), validated on read, and written only on drag end or key press. It is never put in the Yjs doc or awareness, so the interviewer's layout can't affect the candidate's. Other tabs don't live-update on `storage` events; they pick up the layout on their next load.

## Alternatives considered
- **`react-resizable-panels`** — solid and accessible, but it sizes in percentages, so "at least 320 px of editor" has to be recomputed on every resize, and the window-splitter behaviour we need is small. A dependency for a ~150-line feature fails this repo's "why not the alternative" bar.
- **CSS `resize: horizontal`** — gives only a corner grip, isn't keyboard-accessible, and can't express "the editor gets the rest".
- **Sync the layout through Yjs awareness** — the opposite of the requirement: panel sizes are personal and depend on each screen.
- **Stacked panels on narrow screens** (the old behaviour) — the editor ends up below a long statement; tabs keep the editor full-height.

## Consequences
- Verified by `apps/web/e2e/room-layout.e2e.ts`:
  - dragging and keyboard resizing respect the minimums;
  - Monaco follows its column's width;
  - the layout survives a reload, and Reset restores the default;
  - the candidate's layout doesn't change when the interviewer resizes;
  - typing that continues while a drag is in progress keeps every keystroke;
  - at 950 px with oversized saved sizes, Home, dragging and double-click each leave the other panel exactly where it was (and a 900–1000 px sweep in `roomLayout.test.ts`);
  - on narrow screens, tabs switch panels without losing editor content.
- The layout is per browser, not per account: it doesn't follow a user to another machine. That's acceptable for a screen-dependent preference.
