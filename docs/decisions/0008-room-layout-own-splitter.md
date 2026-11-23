# 0008 — Room layout: question | code over tests, own splitter, kept per browser

**Status:** Accepted — implemented (`apps/web/src/lib/roomLayout.ts`, `components/RoomLayout.tsx`, `components/TestPanel.tsx`)

## Context
The room shows the question, the shared editor and test information. People read long statements or long test output, so a fixed split doesn't suit everyone. Resizing must never disturb the shared editor: Monaco is bound to the room's Yjs text through `y-monaco`, and remounting it would tear down the binding (losing cursor, selection and undo history) mid-interview.

The first version had three columns (question | editor | results). It was revised to the arrangement candidates know from coding-practice sites: **question on the left; on the right the code editor stacked over a test panel** with "Testcase" (the public examples, one case at a time) and "Test Result" tabs. The editor gets the full width of the right side, and examples and results sit right under the code they test.

## Decision
- **Layout:** two columns — question | right side; the right side is code (top) over tests (bottom). Two user-adjustable sizes: the question column's **width** (vertical divider) and the test panel's **height** (horizontal divider). The editor takes the rest (`minmax(0, 1fr)` both ways).
- **Our own splitter**: pure, unit-tested layout math (`roomLayout.ts`: clamping, minimums, fitting into the room area) plus a small component that renders the separators.
- **Sizes in pixels with pixel minimums** (question 260 wide; test panel 140 high; editor at least 380 × 160). Saved sizes are *preferences*: a smaller window shows them clamped but doesn't overwrite them, so the layout comes back when the window grows again. **A resize saves both sizes as displayed**, so the size the user didn't touch never moves on the next render. The trade-off: after an explicit resize in a squeezed window, the other size's larger preference is replaced by what was visible.
- **Accessible separators** following the WAI-ARIA window-splitter pattern: `role="separator"` with `aria-orientation`, `aria-valuenow/min/max`, `aria-controls`, focusable. Arrow keys move 16 px (Shift: 64 px) — ←/→ for the question width, ↑/↓ for the test panel (↑ = taller); Home/End go to the minimum/maximum, and a double click resets that divider.
- **One DOM tree in every mode.** Wide, narrow and resized layouts only change CSS (grid tracks, `hidden`); the editor element is never unmounted or moved. Monaco's `automaticLayout` (a ResizeObserver) re-lays the editor out when its pane changes size, including when it becomes visible again.
- **Test panel:** "Testcase" lists only public examples (hidden tests appear as a count, as on the question panel); "Test Result" shows the runs of the question being viewed, and the panel switches to it when a new run for that question starts. In a multi-question room ([ADR 0009](0009-multi-question-rooms.md)) results are scoped to the selected question.
- **Narrow screens (< 768 px of room width) use tabs:** Question / Code / Tests. Tests shows a dot when a result arrives on another tab. The breakpoint is above the side-by-side minimums (664 px).
- **Layout is local to each participant.** It's stored in `localStorage` (`coderoom:room-layout:v2`; the v1 three-column sizes are ignored), validated on read, and written only on drag end or key press. It is never put in the Yjs doc or awareness, so the interviewer's layout can't affect the candidate's. Other tabs don't live-update on `storage` events; they pick up the layout on their next load.

## Alternatives considered
- **Three columns (question | editor | results)** — the first version. Results took width from the editor, and examples and results were far from the code they apply to.
- **`react-resizable-panels`** — solid and accessible, but it sizes in percentages, so "at least 380 px of editor" has to be recomputed on every resize, and the window-splitter behaviour we need is small. A dependency for a feature this size fails this repo's "why not the alternative" bar.
- **CSS `resize`** — gives only a corner grip, isn't keyboard-accessible, and can't express "the editor gets the rest".
- **Sync the layout through Yjs awareness** — the opposite of the requirement: panel sizes are personal and depend on each screen.
- **Stacked panels on narrow screens** — the editor ends up below a long statement; tabs keep the editor full-height.

## Consequences
- Verified by `apps/web/e2e/room-layout.e2e.ts`:
  - dragging and keyboard resizing of both dividers respect the minimums, and Monaco follows its pane's width and height;
  - the layout survives a reload, and Reset restores the default;
  - the candidate's layout doesn't change when the interviewer resizes;
  - a small window squeezes saved sizes without losing them, and resizing one divider leaves the other where it is;
  - typing that continues while a drag is in progress keeps every keystroke;
  - the test panel shows example cases one at a time, never hidden tests, and switches to Test Result on a run;
  - on narrow screens, tabs switch panels without losing editor content.
- The layout is per browser, not per account: it doesn't follow a user to another machine. That's acceptable for a screen-dependent preference.
