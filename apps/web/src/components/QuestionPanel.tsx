import type { CandidateQuestionView } from "@coderoom/shared";

/**
 * The question as a candidate sees it. Used in the room AND in the author's preview, fed by the same
 * server view (public tests only), so the preview is exactly the candidate's view.
 */
export function QuestionPanel({ question }: { question: CandidateQuestionView }) {
  return (
    <aside className="panel question-panel" aria-label="Question">
      <h2>{question.title}</h2>
      <p className="prompt">{question.statement}</p>

      {question.constraints.trim() && (
        <>
          <h3>Constraints</h3>
          <pre className="constraints">{question.constraints}</pre>
        </>
      )}

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
      <p className="muted small">
        {question.hiddenTestCount > 0
          ? `Submit also runs ${question.hiddenTestCount} hidden test${question.hiddenTestCount === 1 ? "" : "s"}. Their inputs are never shown.`
          : "Submit runs the examples above."}
      </p>
    </aside>
  );
}
