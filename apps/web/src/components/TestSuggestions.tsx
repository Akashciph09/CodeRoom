import { useState, type FormEvent } from "react";
import type { CheckedTestSuggestion, TestCaseInput } from "@coderoom/shared";
import { api } from "../lib/api";
import { VERDICT_LABEL } from "../lib/verdicts";

export function TestSuggestions({ questionId, revision, disabled, onAdd }: {
  questionId: string;
  revision: number;
  disabled: boolean;
  onAdd: (tests: TestCaseInput[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [referencePython, setReferencePython] = useState("");
  const [suggestions, setSuggestions] = useState<CheckedTestSuggestion[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function suggest(event: FormEvent) {
    event.preventDefault();
    if (busy || disabled || !referencePython.trim()) return;
    setBusy(true);
    setError(undefined);
    setSuggestions(null);
    setSelected(new Set());
    try {
      const result = await api.suggestQuestionTests(questionId, { revision, referencePython });
      setSuggestions(result.suggestions);
      setReferencePython("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not suggest tests.");
    } finally {
      setBusy(false);
    }
  }

  function addSelected() {
    if (disabled || !suggestions) return;
    const accepted = suggestions.filter((test, index) => test.verdict === "accepted" && selected.has(index));
    if (!accepted.length) return;
    onAdd(accepted.map(({ input, expectedOutput, isHidden }) => ({ input, expectedOutput, isHidden })));
    setSuggestions(null);
    setSelected(new Set());
    setOpen(false);
  }

  return (
    <div className="test-suggestions">
      <button type="button" aria-expanded={open} disabled={busy || (disabled && !open)} onClick={() => setOpen(!open)}>
        {open ? "Close test suggestions" : "Suggest missing tests"}
      </button>
      {open && (
        <form onSubmit={suggest} aria-label="Suggest hidden tests">
          <p className="muted small">Paste a Python solution that reads stdin and writes stdout. CodeRoom keeps it internal and runs it in the worker sandbox.</p>
          <label>
            Python reference solution
            <textarea
              aria-label="Python reference solution"
              className="mono"
              rows={5}
              maxLength={12000}
              value={referencePython}
              disabled={busy || disabled}
              onChange={(event) => setReferencePython(event.target.value)}
              required
            />
          </label>
          <button type="submit" disabled={busy || disabled || !referencePython.trim()}>
            {busy ? "Checking suggestions…" : "Generate suggestions"}
          </button>
          {busy && <p role="status">Generating hidden cases and checking them against your reference…</p>}
          {disabled && <p className="muted small">Save your changes before generating or adding suggestions.</p>}
          {error && <p className="error" role="alert">{error}</p>}
          {suggestions?.length === 0 && <p className="muted small">No new test inputs were suggested.</p>}
          {suggestions && suggestions.length > 0 && (
            <>
              <ul className="test-list" aria-label="Suggested hidden tests">
                {suggestions.map((test, index) => (
                  <li key={test.input} className="test-row">
                    <label className="inline">
                      <input
                        type="checkbox"
                        aria-label={`Add suggested test ${index + 1}`}
                        checked={selected.has(index)}
                        disabled={test.verdict !== "accepted" || disabled}
                        onChange={(event) => {
                          const checked = event.currentTarget.checked;
                          setSelected((current) => {
                            const next = new Set(current);
                            if (checked) next.add(index);
                            else next.delete(index);
                            return next;
                          });
                        }}
                      />
                      Suggested test {index + 1}
                    </label>
                    <p className={test.verdict === "accepted" ? "muted small" : "error small"}>
                      {test.verdict === "accepted" ? "Passed against your reference solution" : `Reference check: ${VERDICT_LABEL[test.verdict]}`}
                    </p>
                    <div className="io">
                      <div><div className="label">Input</div><pre className="code-snapshot">{test.input}</pre></div>
                      <div><div className="label">Expected output</div><pre className="code-snapshot">{test.expectedOutput}</pre></div>
                    </div>
                  </li>
                ))}
              </ul>
              <button type="button" className="primary" disabled={disabled || selected.size === 0} onClick={addSelected}>
                Add selected hidden tests
              </button>
              <p className="muted small">Review the selected cases, then save your draft. Passing checks show agreement with your reference.</p>
            </>
          )}
        </form>
      )}
    </div>
  );
}
