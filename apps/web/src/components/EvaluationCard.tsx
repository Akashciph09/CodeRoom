import { useEffect, useState } from "react";
import {
  evaluationProblems,
  MAX_EXPLANATION_CHARS,
  MAX_EVIDENCE_PER_DIMENSION,
  MAX_SUMMARY_CHARS,
  RECOMMENDATION_LABEL,
  Recommendation,
  RUBRIC,
  type DimensionScore,
  type EvaluationView,
  type EvidenceRef,
  type NoteView,
  type Rating,
  type ReviewQuestion,
  type ReviewSubmission,
} from "@coderoom/shared";
import { api, ApiError } from "../lib/api";
import { applyServerView, formOf, sameForm, toInput, withDimension, type EvaluationForm } from "../lib/evaluation";
import { offsetLabel, submissionLabel } from "../lib/notes";

const RATINGS: Rating[] = [1, 2, 3, 4];

const conflictOf = (err: unknown) => (err instanceof ApiError ? (err.body?.conflict as string | undefined) : undefined);
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The interviewer's structured evaluation of one candidate (ADR 0017), on the review page. A human
 * judgement on the rubric, kept apart from the automated test score — it neither uses nor changes it.
 * Drafts can be saved any time; submitting (after the interview ended) locks it for good.
 */
export function EvaluationCard({
  roomId,
  candidateId,
  candidateName,
  evaluation,
  ended,
  notes,
  submissions,
  questions,
  startedAt,
  onReload,
}: {
  roomId: string;
  candidateId: string;
  candidateName: string;
  /** From the latest review response. */
  evaluation: EvaluationView | null;
  /** The interview has ended: submitting is possible. */
  ended: boolean;
  notes: NoteView[];
  /** This candidate's runs/submissions, oldest first. */
  submissions: ReviewSubmission[];
  questions: ReviewQuestion[];
  startedAt: string;
  /** Re-fetch the review (after a conflict). */
  onReload: () => void;
}) {
  const [state, setState] = useState(() => ({ baseline: evaluation, form: formOf(evaluation) }));
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "info"; text: string; reload?: boolean } | null>(null);

  // Refreshes bring newer server versions; never over unsaved edits, never backwards.
  useEffect(() => {
    setState((s) => applyServerView(s, evaluation));
  }, [evaluation]);

  const { baseline, form } = state;
  const dirty = !sameForm(form, formOf(baseline));
  const problems = evaluationProblems(form);
  const setForm = (update: (f: EvaluationForm) => EvaluationForm) => setState((s) => ({ ...s, form: update(s.form) }));

  function failed(err: unknown) {
    const conflict = conflictOf(err);
    if (conflict === "evaluation_changed") {
      setMessage({ kind: "error", text: "This evaluation was changed in another tab or window. Reload to get the latest version (your unsaved changes here will be lost).", reload: true });
    } else if (conflict === "evaluation_submitted") {
      setMessage({ kind: "error", text: "This evaluation was already submitted and is locked.", reload: true });
    } else {
      setMessage({ kind: "error", text: messageOf(err) });
    }
  }

  /** Save the current form. Edits made while saving are kept (only what was sent is replaced). */
  async function save(): Promise<EvaluationView | null> {
    const sent = form;
    setBusy(true);
    setMessage(null);
    try {
      const saved = await api.saveEvaluation(roomId, candidateId, toInput(sent, baseline?.revision ?? 0));
      setState((s) => ({ baseline: saved, form: sameForm(s.form, sent) ? formOf(saved) : s.form }));
      return saved;
    } catch (err) {
      failed(err);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (
      !window.confirm(
        `Submit your evaluation of ${candidateName}? It will be locked — you won't be able to change it, or edit the notes it cites.`,
      )
    )
      return;
    setSubmitting(true);
    setMessage(null);
    try {
      const current = dirty ? await save() : baseline;
      if (!current) return;
      const submitted = await api.submitEvaluation(roomId, candidateId, current.revision);
      setState({ baseline: submitted, form: formOf(submitted) });
    } catch (err) {
      failed(err);
    } finally {
      setSubmitting(false);
    }
  }

  const evidenceLabel = (ref: EvidenceRef) => {
    if ("noteId" in ref) {
      const n = notes.find((x) => x.id === ref.noteId);
      return n ? `Note ${offsetLabel(n.createdAt, startedAt)} · ${snippet(n.body)}` : "A note";
    }
    const s = submissions.find((x) => x.submissionId === ref.submissionId);
    const q = s && questions.find((x) => x.id === s.roomQuestionId);
    return s ? `${q ? `Q${q.position} · ` : ""}${submissionLabel(s, startedAt)}` : "A run";
  };
  const evidenceHref = (ref: EvidenceRef) => ("noteId" in ref ? `#note-${ref.noteId}` : `#submission-${ref.submissionId}`);

  const locked = baseline?.status === "submitted";

  return (
    <section className="card evaluation" aria-label={`Evaluation of ${candidateName}`}>
      <div className="score-head">
        <h2>Evaluation · {candidateName}</h2>
        <span className={`badge ${locked ? "ready" : ""}`}>{locked ? "Submitted" : baseline ? (dirty ? "Draft · unsaved changes" : "Draft · saved") : dirty ? "Not saved yet" : "Not started"}</span>
      </div>
      <p className="muted small">
        Your judgement against the rubric. It is separate from the test score above — it doesn't use it, and it
        doesn't change it. Save drafts any time; submit once the interview has ended, which locks it.
      </p>

      {locked && baseline ? (
        <LockedEvaluation view={baseline} evidenceLabel={evidenceLabel} evidenceHref={evidenceHref} />
      ) : (
        <fieldset className="evaluation-form" disabled={submitting}>
          {RUBRIC.map((r) => (
            <DimensionField
              key={r.dimension}
              name={`${candidateId}-${r.dimension}`}
              rubric={r}
              value={form.dimensions.find((d) => d.dimension === r.dimension)!}
              onChange={(patch) => setForm((f) => withDimension(f, r.dimension, patch))}
              notes={notes}
              submissions={submissions}
              evidenceLabel={evidenceLabel}
              evidenceHref={evidenceHref}
            />
          ))}

          <fieldset className="rubric-dim">
            <legend>Overall recommendation</legend>
            <div className="recommendations">
              {Recommendation.options.map((rec) => (
                <label key={rec} className={`choice ${form.recommendation === rec ? "chosen" : ""}`}>
                  <input
                    type="radio"
                    name={`${candidateId}-recommendation`}
                    checked={form.recommendation === rec}
                    onChange={() => setForm((f) => ({ ...f, recommendation: rec }))}
                  />
                  {RECOMMENDATION_LABEL[rec]}
                </label>
              ))}
            </div>
          </fieldset>

          <label className="rubric-text">
            <span className="small">Summary (optional)</span>
            <textarea
              aria-label="Evaluation summary"
              rows={3}
              value={form.summary}
              maxLength={MAX_SUMMARY_CHARS}
              onChange={(e) => setForm((f) => ({ ...f, summary: e.target.value }))}
              placeholder="The overall picture, in a few sentences."
            />
          </label>

          <div className="evaluation-actions">
            <button onClick={() => void save()} disabled={busy || !dirty}>
              Save draft
            </button>
            <button className="primary" onClick={() => void submit()} disabled={busy || !ended || problems.length > 0}>
              Submit evaluation
            </button>
            {!ended && <span className="muted small">You can submit once the interview has ended.</span>}
          </div>
          {ended && problems.length > 0 && (
            <div className="muted small submit-problems" role="group" aria-label="Before you can submit">
              Before you can submit:
              <ul>
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          )}
        </fieldset>
      )}
      {message && (
        <p className={`${message.kind === "error" ? "error" : "muted"} small`} role={message.kind === "error" ? "alert" : "status"}>
          {message.text}{" "}
          {message.reload && (
            <button
              className="link small"
              onClick={() => {
                setMessage(null);
                // Drop local edits so the reloaded version is shown.
                setState({ baseline: null, form: formOf(null) });
                onReload();
              }}
            >
              Reload
            </button>
          )}
        </p>
      )}
    </section>
  );
}

const snippet = (s: string) => (s.length > 60 ? `${s.slice(0, 57)}…` : s);

function DimensionField({
  name,
  rubric,
  value,
  onChange,
  notes,
  submissions,
  evidenceLabel,
  evidenceHref,
}: {
  name: string;
  rubric: (typeof RUBRIC)[number];
  value: DimensionScore;
  onChange: (patch: Partial<DimensionScore>) => void;
  notes: NoteView[];
  submissions: ReviewSubmission[];
  evidenceLabel: (ref: EvidenceRef) => string;
  evidenceHref: (ref: EvidenceRef) => string;
}) {
  const chosen = new Set(value.evidence.map((e) => ("noteId" in e ? `n:${e.noteId}` : `s:${e.submissionId}`)));
  const availableNotes = notes.filter((n) => !chosen.has(`n:${n.id}`));
  const availableRuns = [...submissions].reverse().filter((s) => !chosen.has(`s:${s.submissionId}`));
  const full = value.evidence.length >= MAX_EVIDENCE_PER_DIMENSION;

  return (
    <fieldset className="rubric-dim">
      <legend>{rubric.title}</legend>
      <p className="muted small">{rubric.question}</p>
      <div className="rubric-levels">
        {RATINGS.map((n) => (
          <label key={n} className={`choice level ${value.rating === n ? "chosen" : ""}`}>
            <input type="radio" name={name} checked={value.rating === n} onChange={() => onChange({ rating: n, notObserved: false })} />
            <span className="level-num">{n}</span>
            <span className="level-text">{rubric.levels[n]}</span>
          </label>
        ))}
        <label className={`choice level ${value.notObserved ? "chosen" : ""}`}>
          <input type="radio" name={name} checked={value.notObserved} onChange={() => onChange({ rating: null, notObserved: true })} />
          <span className="level-num">–</span>
          <span className="level-text">Not observed — this interview gave no real signal on it.</span>
        </label>
      </div>
      {(value.rating !== null || value.notObserved) && (
        <button className="link small" onClick={() => onChange({ rating: null, notObserved: false })}>
          Clear score
        </button>
      )}
      <label className="rubric-text">
        <span className="small">Why (optional)</span>
        <textarea
          aria-label={`${rubric.title}: explanation`}
          rows={2}
          value={value.explanation}
          maxLength={MAX_EXPLANATION_CHARS}
          onChange={(e) => onChange({ explanation: e.target.value })}
          placeholder="What you saw that supports this score."
        />
      </label>
      <div className="evidence">
        <span className="small">Evidence</span>
        {value.evidence.length > 0 && (
          <ul className="evidence-list" aria-label={`${rubric.title}: evidence`}>
            {value.evidence.map((ref) => (
              <li key={"noteId" in ref ? ref.noteId : ref.submissionId} className="evidence-chip">
                <a href={evidenceHref(ref)}>{evidenceLabel(ref)}</a>
                <button
                  className="link small"
                  aria-label={`Remove ${evidenceLabel(ref)}`}
                  onClick={() => onChange({ evidence: value.evidence.filter((e) => e !== ref) })}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <select
          aria-label={`${rubric.title}: add evidence`}
          className="bare-select"
          value=""
          disabled={full || (availableNotes.length === 0 && availableRuns.length === 0)}
          onChange={(e) => {
            const [kind, id] = e.target.value.split(":") as ["n" | "s", string];
            if (!id) return;
            onChange({ evidence: [...value.evidence, kind === "n" ? { noteId: id } : { submissionId: id }] });
          }}
        >
          <option value="">
            {full ? `At most ${MAX_EVIDENCE_PER_DIMENSION}` : availableNotes.length + availableRuns.length === 0 ? "Nothing to link" : "Link a note or run…"}
          </option>
          {availableNotes.length > 0 && (
            <optgroup label="Notes">
              {availableNotes.map((n) => (
                <option key={n.id} value={`n:${n.id}`}>
                  {evidenceLabel({ noteId: n.id })}
                </option>
              ))}
            </optgroup>
          )}
          {availableRuns.length > 0 && (
            <optgroup label="Runs and submissions">
              {availableRuns.map((s) => (
                <option key={s.submissionId} value={`s:${s.submissionId}`}>
                  {evidenceLabel({ submissionId: s.submissionId })}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </div>
    </fieldset>
  );
}

function LockedEvaluation({
  view,
  evidenceLabel,
  evidenceHref,
}: {
  view: EvaluationView;
  evidenceLabel: (ref: EvidenceRef) => string;
  evidenceHref: (ref: EvidenceRef) => string;
}) {
  return (
    <div className="evaluation-locked">
      <p className="small">
        <span aria-hidden="true">🔒 </span>Submitted by {view.submittedBy?.name ?? "the interviewer"}{" "}
        {view.submittedAt && <time dateTime={view.submittedAt}>{new Date(view.submittedAt).toLocaleString()}</time>} · locked
      </p>
      <dl className="rubric-result">
        {RUBRIC.map((r) => {
          const d = view.dimensions.find((x) => x.dimension === r.dimension)!;
          return (
            <div key={r.dimension} className="rubric-result-row" aria-label={r.title}>
              <dt>{r.title}</dt>
              <dd>
                <strong>{d.notObserved ? "Not observed" : d.rating !== null ? `${d.rating} / 4` : "—"}</strong>
                {d.rating !== null && <span className="muted small"> · {r.levels[d.rating as Rating]}</span>}
                {d.explanation && <p className="note-body">{d.explanation}</p>}
                {d.evidence.length > 0 && (
                  <ul className="evidence-list">
                    {d.evidence.map((ref) => (
                      <li key={"noteId" in ref ? ref.noteId : ref.submissionId} className="evidence-chip">
                        <a href={evidenceHref(ref)}>{evidenceLabel(ref)}</a>
                      </li>
                    ))}
                  </ul>
                )}
              </dd>
            </div>
          );
        })}
        <div className="rubric-result-row" aria-label="Overall recommendation">
          <dt>Overall recommendation</dt>
          <dd>
            <strong>{view.recommendation ? RECOMMENDATION_LABEL[view.recommendation] : "—"}</strong>
          </dd>
        </div>
        {view.summary && (
          <div className="rubric-result-row" aria-label="Summary">
            <dt>Summary</dt>
            <dd className="note-body">{view.summary}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}
