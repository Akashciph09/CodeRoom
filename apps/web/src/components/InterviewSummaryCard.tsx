import { useState } from "react";
import type { InterviewSummary } from "@coderoom/shared";
import { api } from "../lib/api";

const sections = {
  went_well: "What went well",
  difficulties: "Difficulties",
  follow_up: "Questions to probe next time",
} satisfies Record<InterviewSummary["items"][number]["section"], string>;

export function InterviewSummaryCard({ roomId }: { roomId: string }) {
  const [summary, setSummary] = useState<InterviewSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function draft() {
    setBusy(true);
    setError(undefined);
    try {
      const response = await api.draftInterviewSummary(roomId);
      if (response.items.length === 0) {
        setError("The model returned no observations with valid citations.");
      } else {
        setSummary(response);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not draft the summary.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card interview-summary" aria-label="Interview summary">
      <h2>Interview summary</h2>
      <p className="muted small">Draft with AI using the review evidence. Check the citations and edit the wording before using it.</p>
      {summary ? (
        <>
          {(Object.entries(sections) as [keyof typeof sections, string][]).map(([section, label]) => {
            const items = summary.items.filter((item) => item.section === section);
            return items.length > 0 && (
              <section key={section}>
                <h3>{label}</h3>
                <ul>
                  {items.map((item, index) => (
                    <li key={index}>
                      <textarea aria-label={`${label}, point ${index + 1}`} defaultValue={item.text} rows={3} />
                      <div className="summary-citations">
                        {item.citations.map(({ anchor, label }) => <a key={anchor} href={`#${anchor}`}>{label}</a>)}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
          <button type="button" onClick={() => setSummary(null)}>Discard draft</button>
        </>
      ) : (
        <button type="button" className="primary" disabled={busy} onClick={() => void draft()}>
          {busy ? "Drafting…" : "Draft a summary"}
        </button>
      )}
      {busy && <p className="muted small" role="status">Reading interview evidence…</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
