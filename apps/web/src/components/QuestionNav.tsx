import type { RoomQuestionView } from "@coderoom/shared";

/**
 * Switch between a room's questions. The candidate only ever receives revealed questions, so for them
 * this lists exactly what they may see; the interviewer also sees the locked ones still to reveal.
 */
export function QuestionNav({
  questions,
  activePosition,
  onSelect,
}: {
  questions: RoomQuestionView[];
  activePosition: number;
  onSelect: (position: number) => void;
}) {
  return (
    <nav className="question-nav" aria-label="Questions">
      {questions.map((q) => {
        const current = q.position === activePosition;
        return (
          <button
            key={q.id}
            className={`${current ? "active" : ""} ${q.revealed ? "" : "locked"}`}
            aria-current={current ? "true" : undefined}
            aria-label={`Q${q.position}: ${q.question.title}${q.revealed ? "" : " (not revealed)"}`}
            title={q.question.title}
            onClick={() => onSelect(q.position)}
          >
            Q{q.position}
            {!q.revealed && <span aria-hidden="true"> 🔒</span>}
          </button>
        );
      })}
    </nav>
  );
}
