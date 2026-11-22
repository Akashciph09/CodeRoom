import type { RoomView } from "@coderoom/shared";

export function QuestionPanel({ room }: { room: RoomView }) {
  const { question } = room;
  return (
    <aside className="panel question-panel">
      <h2>{question.title}</h2>
      <p className="prompt">{question.prompt}</p>
      <h3>Examples</h3>
      {question.publicTests.map((t, i) => (
        <div key={t.id} className="example">
          <div className="muted">Example {i + 1}</div>
          <div className="io">
            <div>
              <span className="label">Input</span>
              <pre>{t.input}</pre>
            </div>
            <div>
              <span className="label">Output</span>
              <pre>{t.expectedOutput}</pre>
            </div>
          </div>
        </div>
      ))}
      <p className="muted small">Submit also runs hidden tests. Their inputs are never shown.</p>
    </aside>
  );
}
