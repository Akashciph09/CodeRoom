import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type {
  CandidateQuestionView,
  Language,
  PublishProblem,
  QuestionDetail,
  QuestionDraftInput,
  QuestionVersionView,
} from "@coderoom/shared";
import { QuestionPanel } from "../components/QuestionPanel";
import { TopBar } from "../components/TopBar";
import { api, ApiError, isDraftConflict, publishProblemsOf } from "../lib/api";

interface TestRow {
  key: string;
  input: string;
  expectedOutput: string;
  isHidden: boolean;
}

interface Form {
  title: string;
  statement: string;
  constraints: string;
  starter: Record<Language, string>;
  tests: TestRow[];
}

const LANGUAGES: { id: Language; label: string }[] = [
  { id: "python", label: "Python" },
  { id: "javascript", label: "JavaScript" },
];

const PROBLEM_TEXT: Record<PublishProblem, string> = {
  missing_title: "Add a title.",
  missing_statement: "Write the problem statement.",
  no_tests: "Add at least one test case.",
  no_public_tests: "Make at least one test public, so the candidate has an example.",
  empty_expected_output: "Every test needs an expected output.",
};

const newRow = (isHidden = false): TestRow => ({ key: crypto.randomUUID(), input: "", expectedOutput: "", isHidden });

function formFrom(v: QuestionVersionView): Form {
  return {
    title: v.title,
    statement: v.statement,
    constraints: v.constraints,
    starter: { python: v.starterCode.python ?? "", javascript: v.starterCode.javascript ?? "" },
    tests: v.tests.map((t) => ({ key: t.id, input: t.input, expectedOutput: t.expectedOutput, isHidden: t.isHidden })),
  };
}

/** Draft content from the form (the revision is added when sending). */
function toDraftInput(f: Form): Omit<QuestionDraftInput, "baseRevision"> {
  return {
    title: f.title.trim() || "Untitled question",
    statement: f.statement,
    constraints: f.constraints,
    // Empty starter = "no starter code for this language".
    starterCode: Object.fromEntries(LANGUAGES.filter((l) => f.starter[l.id].trim()).map((l) => [l.id, f.starter[l.id]])),
    tests: f.tests.map(({ input, expectedOutput, isHidden }) => ({ input, expectedOutput, isHidden })),
  };
}

/** Comparable snapshot of a form (ignores React keys). */
const snapshot = (f: Form | null) => (f ? JSON.stringify(toDraftInput(f)) : "");

export function QuestionEditorPage() {
  const { questionId = "" } = useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<QuestionDetail | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [baseline, setBaseline] = useState("");
  const [starterLang, setStarterLang] = useState<Language>("python");
  const [preview, setPreview] = useState<CandidateQuestionView | null>(null);
  const [problems, setProblems] = useState<PublishProblem[]>([]);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  /** Form is read-only while an operation that replaces its content (publish/discard/delete) runs. */
  const [locked, setLocked] = useState(false);
  /** The draft changed elsewhere since this tab loaded it; saving would overwrite someone's work. */
  const [conflict, setConflict] = useState(false);

  /**
   * Apply a server response. The form is replaced with the server's content only if it still holds
   * exactly what was sent (`sent`); edits typed while the request was in flight are kept — and stay
   * "unsaved", because the baseline becomes what the server now has. `sent` omitted = replace.
   */
  const applyServer = useCallback((d: QuestionDetail, sent?: string) => {
    setDetail(d);
    setConflict(false);
    const source = d.draft ?? d.latest;
    const serverForm = source ? formFrom(source) : null;
    setBaseline(snapshot(serverForm));
    setForm((current) => (sent === undefined || !current || snapshot(current) === sent ? serverForm : current));
  }, []);

  useEffect(() => {
    api.question(questionId).then((d) => applyServer(d), (err: unknown) =>
      setMessage({
        kind: "error",
        text: err instanceof ApiError && err.status === 404 ? "Question not found." : String(err),
      }),
    );
  }, [questionId, applyServer]);

  const dirty = useMemo(() => form !== null && snapshot(form) !== baseline, [form, baseline]);

  // Warn before leaving with unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const update = (patch: Partial<Form>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const updateTest = (i: number, patch: Partial<TestRow>) =>
    setForm((f) => (f ? { ...f, tests: f.tests.map((t, j) => (j === i ? { ...t, ...patch } : t)) } : f));
  const moveTest = (i: number, delta: -1 | 1) =>
    setForm((f) => {
      if (!f) return f;
      const tests = f.tests.slice();
      const [row] = tests.splice(i, 1);
      tests.splice(i + delta, 0, row!);
      return { ...f, tests };
    });

  /** Run an action with shared busy/error handling. `lock` makes the form read-only meanwhile. */
  async function run(action: () => Promise<void>, opts: { lock?: boolean } = {}) {
    setBusy(true);
    setLocked(Boolean(opts.lock));
    setMessage(null);
    try {
      await action();
    } catch (err) {
      if (isDraftConflict(err)) setConflict(true);
      else setMessage({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
      setLocked(false);
    }
  }

  /** The draft revision this tab's edits are based on (null = editing on top of the ready version). */
  const baseRevision = detail?.draft?.revision ?? null;

  async function saveIfDirty(): Promise<QuestionDetail | null> {
    if (!form || !dirty) return detail;
    const payload = toDraftInput(form);
    const sent = snapshot(form);
    const d = await api.saveDraft(questionId, { ...payload, baseRevision });
    applyServer(d, sent);
    return d;
  }

  /** Drop local edits and load what the server has now (after a conflict). */
  const reloadLatest = () =>
    run(async () => {
      applyServer(await api.question(questionId));
      setMessage({ kind: "ok", text: "Loaded the latest version." });
    });

  const save = () =>
    run(async () => {
      await saveIfDirty();
      setProblems([]);
      setMessage({ kind: "ok", text: "Draft saved." });
    });

  const showPreview = () =>
    run(async () => {
      const d = await saveIfDirty();
      setPreview(await api.previewQuestion(questionId, d?.draft ? "draft" : "latest"));
    });

  const markReady = () =>
    run(
      async () => {
        const saved = await saveIfDirty();
        const revision = saved?.draft?.revision;
        if (revision === undefined) return;
        try {
          const d = await api.publishQuestion(questionId, revision);
          applyServer(d);
          setProblems([]);
          setMessage({ kind: "ok", text: `Marked ready as version ${d.latest?.version}. New interviews will use it.` });
        } catch (err) {
          const found = publishProblemsOf(err);
          if (found.length === 0) throw err;
          setProblems(found);
        }
      },
      { lock: true },
    );

  const discard = () =>
    run(
      async () => {
        if (baseRevision === null) return;
        if (!confirm("Discard your unpublished changes? The ready version stays as it is.")) return;
        applyServer(await api.discardDraft(questionId, baseRevision));
        setMessage({ kind: "ok", text: "Changes discarded." });
      },
      { lock: true },
    );

  const remove = () =>
    run(
      async () => {
        if (!confirm("Delete this question? This can't be undone.")) return;
        await api.deleteQuestion(questionId);
        navigate("/questions");
      },
      { lock: true },
    );

  const startInterview = () =>
    run(async () => {
      const { roomId } = await api.createRoom(questionId);
      navigate(`/rooms/${roomId}`);
    });

  if (!detail || !form) {
    return (
      <>
        <TopBar />
        <main className="center">{message ? <p className="error">{message.text}</p> : <p className="muted">Loading…</p>}</main>
      </>
    );
  }

  const latest = detail.latest?.version;
  const hasDraft = detail.draft !== null;
  const canPublish = hasDraft || dirty;

  return (
    <>
      <TopBar />
      <main className="editor-page">
        <div className="page-head">
          <div>
            <Link to="/questions" className="muted small">
              ← My questions
            </Link>
            <h1>{form.title || "Untitled question"}</h1>
            <p className="muted small" data-testid="question-status">
              {latest === undefined
                ? "Draft — not available for interviews until you mark it ready."
                : hasDraft || dirty
                  ? `Ready v${latest}. You're editing a draft — interviews keep using v${latest} until you mark this ready.`
                  : `Ready v${latest}. Saving changes starts a new draft; existing interviews keep their version.`}
              {detail.roomCount > 0 && ` Used in ${detail.roomCount} interview${detail.roomCount === 1 ? "" : "s"}.`}
            </p>
          </div>
          <div className="actions">
            {preview ? (
              <button onClick={() => setPreview(null)}>Back to editing</button>
            ) : (
              <>
                <button onClick={save} disabled={busy || !dirty}>
                  Save draft
                </button>
                <button onClick={showPreview} disabled={busy}>
                  Preview
                </button>
                <button className="primary" onClick={markReady} disabled={busy || !canPublish}>
                  Mark ready
                </button>
              </>
            )}
            {latest !== undefined && !dirty && !preview && (
              <button className="ghost" onClick={startInterview} disabled={busy}>
                Start interview
              </button>
            )}
          </div>
        </div>

        {conflict && (
          <div className="error-box" role="alert" aria-label="Draft conflict">
            <strong>This draft was changed in another tab or window.</strong> Your edits here weren't saved, so
            nothing was overwritten. Copy anything you want to keep, then reload the latest version.
            <div className="actions" style={{ marginTop: 8 }}>
              <button onClick={reloadLatest} disabled={busy}>
                Reload latest
              </button>
            </div>
          </div>
        )}
        {message && <p className={message.kind === "ok" ? "notice" : "error"}>{message.text}</p>}
        {problems.length > 0 && (
          <div className="error-box" role="alert">
            <strong>Not ready yet:</strong>
            <ul>
              {problems.map((p) => (
                <li key={p}>{PROBLEM_TEXT[p]}</li>
              ))}
            </ul>
          </div>
        )}

        {preview ? (
          <section className="preview" aria-label="Candidate preview">
            <p className="muted small">
              This is exactly what the candidate sees{preview.version ? ` (version ${preview.version})` : " (current draft)"}.
            </p>
            <div className="preview-grid">
              <QuestionPanel question={preview} />
              <div className="panel">
                <h3>Editor starts with</h3>
                {LANGUAGES.map((l) => (
                  <div key={l.id}>
                    <div className="label">{l.label}</div>
                    <pre className="code-snapshot">{preview.starterCode[l.id] ?? "(empty — default template)"}</pre>
                  </div>
                ))}
              </div>
            </div>
          </section>
        ) : (
          <fieldset className="editor-form" disabled={locked} aria-busy={locked}>
            <section className="card">
              <label>
                Title
                <input aria-label="Title" value={form.title} onChange={(e) => update({ title: e.target.value })} maxLength={200} />
              </label>
              <label>
                Problem statement
                <textarea
                  aria-label="Problem statement"
                  rows={8}
                  value={form.statement}
                  onChange={(e) => update({ statement: e.target.value })}
                  placeholder="Describe the problem, the input format and the expected output."
                />
              </label>
              <label>
                Constraints
                <textarea
                  aria-label="Constraints"
                  rows={3}
                  className="mono"
                  value={form.constraints}
                  onChange={(e) => update({ constraints: e.target.value })}
                  placeholder="e.g. 1 <= n <= 10^5"
                />
              </label>
            </section>

            <section className="card">
              <div className="section-head">
                <h2>Starter code</h2>
                <div className="tabs small-tabs" role="tablist">
                  {LANGUAGES.map((l) => (
                    <button
                      key={l.id}
                      role="tab"
                      aria-selected={starterLang === l.id}
                      className={starterLang === l.id ? "active" : ""}
                      onClick={() => setStarterLang(l.id)}
                    >
                      {l.label}
                    </button>
                  ))}
                </div>
              </div>
              <textarea
                aria-label={`${LANGUAGES.find((l) => l.id === starterLang)!.label} starter code`}
                className="mono"
                rows={8}
                value={form.starter[starterLang]}
                onChange={(e) => update({ starter: { ...form.starter, [starterLang]: e.target.value } })}
                placeholder="Optional. Leave empty to use the default template."
              />
            </section>

            <section className="card">
              <div className="section-head">
                <h2>Test cases</h2>
                <span className="muted small">
                  {form.tests.filter((t) => !t.isHidden).length} public · {form.tests.filter((t) => t.isHidden).length} hidden
                </span>
              </div>
              <p className="muted small">
                Public tests are shown to the candidate as examples and used by Run. Submit runs all of them. Hidden
                inputs and outputs are never shown to the candidate.
              </p>
              <ol className="test-list">
                {form.tests.map((t, i) => {
                  const n = i + 1;
                  return (
                    <li key={t.key} className={`test-row ${t.isHidden ? "hidden-test" : ""}`}>
                      <div className="test-row-head">
                        <strong>Test {n}</strong>
                        <label className="inline">
                          <input
                            type="checkbox"
                            checked={t.isHidden}
                            onChange={(e) => updateTest(i, { isHidden: e.target.checked })}
                            aria-label={`Test ${n} hidden`}
                          />
                          Hidden
                        </label>
                        <div className="spacer" />
                        <button className="ghost" onClick={() => moveTest(i, -1)} disabled={i === 0} aria-label={`Move test ${n} up`}>
                          ↑
                        </button>
                        <button
                          className="ghost"
                          onClick={() => moveTest(i, 1)}
                          disabled={i === form.tests.length - 1}
                          aria-label={`Move test ${n} down`}
                        >
                          ↓
                        </button>
                        <button
                          className="ghost"
                          onClick={() => update({ tests: form.tests.filter((_, j) => j !== i) })}
                          aria-label={`Remove test ${n}`}
                        >
                          Remove
                        </button>
                      </div>
                      <div className="io">
                        <label>
                          Input
                          <textarea
                            className="mono"
                            rows={3}
                            value={t.input}
                            onChange={(e) => updateTest(i, { input: e.target.value })}
                            aria-label={`Test ${n} input`}
                          />
                        </label>
                        <label>
                          Expected output
                          <textarea
                            className="mono"
                            rows={3}
                            value={t.expectedOutput}
                            onChange={(e) => updateTest(i, { expectedOutput: e.target.value })}
                            aria-label={`Test ${n} expected output`}
                          />
                        </label>
                      </div>
                    </li>
                  );
                })}
              </ol>
              <div className="actions">
                <button onClick={() => update({ tests: [...form.tests, newRow(false)] })}>Add public test</button>
                <button onClick={() => update({ tests: [...form.tests, newRow(true)] })}>Add hidden test</button>
              </div>
            </section>

            <section className="danger-zone">
              {hasDraft && latest !== undefined && (
                <button className="ghost" onClick={discard} disabled={busy}>
                  Discard unpublished changes
                </button>
              )}
              {latest === undefined && (
                <button className="danger" onClick={remove} disabled={busy}>
                  Delete question
                </button>
              )}
              {detail.versions.length > 0 && (
                <span className="muted small">
                  Versions: {detail.versions.map((v) => `v${v.version}`).join(", ")} — each stays exactly as published.
                </span>
              )}
            </section>
          </fieldset>
        )}
      </main>
    </>
  );
}
