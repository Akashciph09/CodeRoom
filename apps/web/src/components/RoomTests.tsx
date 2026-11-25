import { useState } from "react";
import { MAX_ROOM_TEST_CASES, type RoomTestCase, type RoomTestSuggestion } from "@coderoom/shared";
import { api } from "../lib/api";

export function RoomTests({ roomId, questionId, tests, onAdded }: {
  roomId: string;
  questionId: string;
  tests: RoomTestCase[];
  onAdded: () => void;
}) {
  const [suggestions, setSuggestions] = useState<RoomTestSuggestion[]>([]);
  const [editing, setEditing] = useState<{ input: string; expectedOutput: string; suggestionIndex?: number }>();
  const [referencePython, setReferencePython] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<"suggest" | "add">();
  const [message, setMessage] = useState<{ text: string; error: boolean }>();
  const full = tests.length >= MAX_ROOM_TEST_CASES;

  async function suggest() {
    setBusy("suggest");
    setMessage(undefined);
    try {
      setSuggestions((await api.suggestRoomTests(roomId, questionId)).tests);
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : "Could not suggest tests.", error: true });
    } finally {
      setBusy(undefined);
    }
  }

  function select(input: string, expectedOutput: string, suggestionIndex?: number) {
    setEditing({ input, expectedOutput, suggestionIndex });
    setConfirmed(false);
    setMessage(undefined);
  }

  async function add(isHidden: boolean) {
    if (!editing || busy || full || !editing.expectedOutput.trim() || (!confirmed && !referencePython.trim())) return;
    setBusy("add");
    setMessage(undefined);
    try {
      await api.addRoomTest(roomId, questionId, {
        input: editing.input,
        expectedOutput: editing.expectedOutput,
        isHidden,
        confirmed,
        ...(referencePython.trim() ? { referencePython } : {}),
      });
      setSuggestions((current) => current.filter((_, index) => index !== editing.suggestionIndex));
      setEditing(undefined);
      setConfirmed(false);
      setMessage({ text: isHidden ? "Hidden test added for future submissions." : "Public test added for future runs and submissions.", error: false });
      onAdded();
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : "Could not add the test.", error: true });
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <section className="room-test-tools" role="group" aria-label="Graded room tests">
      <div className="actions">
        <button type="button" disabled={Boolean(busy) || full} onClick={() => select("", "")}>Add test case</button>
        <button type="button" disabled={Boolean(busy) || full || Boolean(editing)} onClick={() => void suggest()}>
          {busy === "suggest" ? "Generating…" : "Suggest test cases"}
        </button>
      </div>
      {full && <p className="muted small">This room question has reached its test limit.</p>}
      {suggestions.length > 0 && (
        <ol className="test-list room-test-suggestions" aria-label="Suggested room tests">
          {suggestions.map((test, index) => (
            <li key={index} className="test-row">
              <p className="small">{test.reason}</p>
              <div className="io">
                <div><div className="label">Input</div><pre className="code-snapshot">{test.input}</pre></div>
                <div><div className="label">Expected output</div><pre className="code-snapshot">{test.expectedOutput}</pre></div>
              </div>
              <button type="button" disabled={Boolean(busy) || full} onClick={() => select(test.input, test.expectedOutput, index)}>
                Review suggestion {index + 1}
              </button>
            </li>
          ))}
        </ol>
      )}
      {editing && (
        <fieldset className="room-test-edit" disabled={Boolean(busy)}>
          <legend>Review test case</legend>
          <label>
            Input
            <textarea aria-label="Room test input" rows={2} maxLength={4096} value={editing.input} onChange={(event) => {
              setEditing({ ...editing, input: event.target.value });
              setConfirmed(false);
            }} />
          </label>
          <label>
            Expected output
            <textarea aria-label="Room test expected output" rows={2} maxLength={4096} value={editing.expectedOutput} onChange={(event) => {
              setEditing({ ...editing, expectedOutput: event.target.value });
              setConfirmed(false);
            }} />
          </label>
          <details>
            <summary>Use a trusted Python reference</summary>
            <label>
              Python reference solution
              <textarea aria-label="Room test Python reference" className="mono" rows={4} maxLength={12000} value={referencePython}
                onChange={(event) => setReferencePython(event.target.value)} />
            </label>
          </details>
          {referencePython.trim() ? (
            <p className="muted small">The worker checks this input and expected output against your reference before adding it.</p>
          ) : (
            <label className="inline small">
              <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
              I confirm the expected output is correct.
            </label>
          )}
          <div className="actions">
            <button type="button" disabled={full || !editing.expectedOutput.trim() || (!confirmed && !referencePython.trim())} onClick={() => void add(false)}>
              Add as public
            </button>
            <button type="button" disabled={full || !editing.expectedOutput.trim() || (!confirmed && !referencePython.trim())} onClick={() => void add(true)}>
              Add as hidden
            </button>
            <button type="button" onClick={() => setEditing(undefined)}>Cancel</button>
          </div>
        </fieldset>
      )}
      {busy === "add" && <p className="small muted" role="status">Adding the test…</p>}
      {message && <p className={message.error ? "error small" : "muted small"} role={message.error ? "alert" : "status"}>{message.text}</p>}
      {tests.length > 0 && (
        <details>
          <summary>Room additions ({tests.length})</summary>
          <ol className="test-list" aria-label="Added room tests">
            {tests.map((test) => (
              <li key={test.id} className="test-row">
                <span className="badge">{test.isHidden ? "Hidden" : "Public"}</span>
                <div className="io">
                  <div><div className="label">Input</div><pre className="code-snapshot">{test.input}</pre></div>
                  <div><div className="label">Expected output</div><pre className="code-snapshot">{test.expectedOutput}</pre></div>
                </div>
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}
