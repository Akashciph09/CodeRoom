import { useEffect, useState } from "react";
import type { InterviewSummaryDraft } from "@coderoom/shared";
import { api } from "../lib/api";

const sections = {
  went_well: "What went well",
  difficulties: "Difficulties",
  follow_up: "Questions to probe next time",
} satisfies Record<InterviewSummaryDraft["items"][number]["section"], string>;

export function InterviewSummaryCard({ roomId }: { roomId: string }) {
  const [summary, setSummary] = useState<InterviewSummaryDraft | null>();
  const [texts, setTexts] = useState<string[]>([]);
  const [busy, setBusy] = useState<"draft" | "save" | "discard">();
  const [error, setError] = useState<string>();
  const [loadAttempt, setLoadAttempt] = useState(0);

  function applyDraft(draft: InterviewSummaryDraft | null) {
    setSummary(draft);
    setTexts(draft?.items.map((item) => item.text) ?? []);
  }

  useEffect(() => {
    let current = true;
    api.interviewSummary(roomId).then(
      (saved) => { if (current) applyDraft(saved); },
      () => { if (current) setError("Could not load your saved summary."); },
    );
    return () => { current = false; };
  }, [roomId, loadAttempt]);

  const dirty = summary?.items.some((item, index) => item.text !== texts[index]) ?? false;

  async function update(action: NonNullable<typeof busy>, operation: () => Promise<InterviewSummaryDraft | null>) {
    setBusy(action);
    setError(undefined);
    try {
      applyDraft(await operation());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update the summary.");
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <section className="card interview-summary" aria-label="Interview summary">
      <h2>Interview summary</h2>
      <p className="muted small">Draft with AI using the review evidence. Check the citations and edit the wording before using it.</p>
      {summary === undefined ? (
        error ? <button type="button" onClick={() => {
          setError(undefined);
          setLoadAttempt((attempt) => attempt + 1);
        }}>Retry loading summary</button> : <p role="status">Loading summary…</p>
      ) : summary ? (
        <>
          {(Object.entries(sections) as [keyof typeof sections, string][]).map(([section, label]) => {
            const items = summary.items.map((item, index) => ({ item, index })).filter(({ item }) => item.section === section);
            return items.length > 0 && (
              <section key={section}>
                <h3>{label}</h3>
                <ul>
                  {items.map(({ item, index }, number) => (
                    <li key={index}>
                      <textarea
                        aria-label={`${label}, point ${number + 1}`}
                        value={texts[index] ?? ""}
                        disabled={Boolean(busy)}
                        maxLength={2000}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          setTexts((current) => current.map((text, i) => i === index ? value : text));
                        }}
                        rows={3}
                      />
                      <div className="summary-citations">
                        {item.citations.map(({ anchor, label }) => <a key={anchor} href={`#${anchor}`}>{label}</a>)}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
          <div className="actions">
            <button
              type="button"
              className="primary"
              disabled={Boolean(busy) || !dirty || texts.some((text) => !text.trim())}
              onClick={() => void update("save", () => api.saveInterviewSummary(roomId, { revision: summary.revision, texts }))}
            >
              {busy === "save" ? "Saving…" : "Save edits"}
            </button>
            <button type="button" disabled={Boolean(busy)} onClick={() => void update("discard", async () => {
              await api.discardInterviewSummary(roomId, summary.revision);
              return null;
            })}>
              {busy === "discard" ? "Discarding…" : "Discard draft"}
            </button>
          </div>
          {dirty && <p className="muted small">Save edits to keep your changes when you leave this page.</p>}
        </>
      ) : (
        <button type="button" className="primary" disabled={Boolean(busy)} onClick={() => void update("draft", () => api.draftInterviewSummary(roomId))}>
          {busy === "draft" ? "Drafting…" : "Draft a summary"}
        </button>
      )}
      {busy === "draft" && <p className="muted small" role="status">Reading interview evidence…</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
