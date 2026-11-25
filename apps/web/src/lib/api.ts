import type {
  AddRoomTestRequest,
  RoomTestSuggestions,
  CandidateQuestionView,
  CandidateSubmissionView,
  CreateRoomResponse,
  CreateSubmissionRequest,
  CreateSubmissionResponse,
  EvaluationDraftInput,
  EvaluationView,
  InterviewerSubmissionView,
  InterviewSummaryDraft,
  EditSummaryDraftRequest,
  JoinRoomResponse,
  MyQuestionSummary,
  NoteRequest,
  NoteView,
  PublishProblem,
  QuestionDetail,
  QuestionDraftInput,
  QuestionSummary,
  RoomSummary,
  RoomReview,
  RoomView,
} from "@coderoom/shared";
import { getAccessToken } from "./auth";
import { API_URL } from "./config";

export type SubmissionView = CandidateSubmissionView | InterviewerSubmissionView;

export const isInterviewerView = (v: SubmissionView): v is InterviewerSubmissionView => "results" in v;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** Parsed JSON error body (e.g. `problems` when a question can't be marked ready). */
    public readonly body: Record<string, unknown> | null = null,
  ) {
    super(message);
  }
}

/** True if this is the server saying the draft changed elsewhere since this tab loaded it. */
export const isDraftConflict = (err: unknown) => err instanceof ApiError && err.body?.conflict === "draft_changed";

/** The reasons a question can't be marked ready, if that's what this error is. */
export const publishProblemsOf = (err: unknown): PublishProblem[] =>
  err instanceof ApiError && Array.isArray(err.body?.problems) ? (err.body.problems as PublishProblem[]) : [];

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const body = (json ?? null) as Record<string, unknown> | null;
    throw new ApiError(res.status, (body?.error as string | undefined) ?? res.statusText, body);
  }
  return json as T;
}

export const api = {
  questions: () => request<QuestionSummary[]>("GET", "/questions"),
  myRooms: () => request<RoomSummary[]>("GET", "/rooms"),
  createRoom: (questionIds: string[], questionPoints?: number[], name?: string) =>
    request<CreateRoomResponse>("POST", "/rooms", {
      questionIds,
      ...(questionPoints ? { questionPoints } : {}),
      ...(name?.trim() ? { name } : {}),
    }),
  /** Rename or clear (empty) the room's name — interviewer only (ADR 0014). */
  renameRoom: (roomId: string, name: string) =>
    request<{ roomId: string; name: string | null }>("PATCH", `/rooms/${roomId}`, { name }),
  /** The interviewer's private notes (ADR 0016) — interviewer-only routes. */
  notes: (roomId: string) => request<NoteView[]>("GET", `/rooms/${roomId}/notes`),
  addNote: (roomId: string, note: NoteRequest) => request<NoteView>("POST", `/rooms/${roomId}/notes`, note),
  editNote: (roomId: string, noteId: string, note: NoteRequest) => request<NoteView>("PATCH", `/rooms/${roomId}/notes/${noteId}`, note),
  deleteNote: (roomId: string, noteId: string) => request<void>("DELETE", `/rooms/${roomId}/notes/${noteId}`),
  /** The interviewer's structured evaluation (ADR 0017): save a draft / submit and lock. */
  saveEvaluation: (roomId: string, candidateId: string, input: EvaluationDraftInput) =>
    request<EvaluationView>("PUT", `/rooms/${roomId}/evaluations/${candidateId}`, input),
  submitEvaluation: (roomId: string, candidateId: string, revision: number) =>
    request<EvaluationView>("POST", `/rooms/${roomId}/evaluations/${candidateId}/submit`, { revision }),
  /** Interviewer-only post-interview review (ADR 0011). */
  interviewSummary: (roomId: string) => request<InterviewSummaryDraft | null>("GET", `/rooms/${roomId}/review/summary`),
  draftInterviewSummary: (roomId: string) => request<InterviewSummaryDraft>("POST", `/rooms/${roomId}/review/summary`),
  saveInterviewSummary: (roomId: string, draft: EditSummaryDraftRequest) =>
    request<InterviewSummaryDraft>("PUT", `/rooms/${roomId}/review/summary`, draft),
  discardInterviewSummary: (roomId: string, revision: number) =>
    request<void>("DELETE", `/rooms/${roomId}/review/summary`, { revision }),
  review: (roomId: string) => request<RoomReview>("GET", `/rooms/${roomId}/review`),
  revealQuestion: (roomId: string, roomQuestionId: string) =>
    request<{ roomQuestionId: string; revealed: true }>("POST", `/rooms/${roomId}/questions/${roomQuestionId}/reveal`),
  joinRoom: (inviteCode: string) => request<JoinRoomResponse>("POST", "/rooms/join", { inviteCode }),
  suggestRoomTests: (roomId: string, questionId: string) =>
    request<RoomTestSuggestions>("POST", `/rooms/${roomId}/questions/${questionId}/tests/suggest`),
  addRoomTest: (roomId: string, questionId: string, test: AddRoomTestRequest) =>
    request<void>("POST", `/rooms/${roomId}/questions/${questionId}/tests`, test),
  room: (roomId: string) => request<RoomView>("GET", `/rooms/${roomId}`),
  roomSubmissions: (roomId: string, questionId?: string) =>
    request<SubmissionView[]>("GET", `/rooms/${roomId}/submissions${questionId ? `?questionId=${encodeURIComponent(questionId)}` : ""}`),
  submission: (submissionId: string) => request<SubmissionView>("GET", `/submissions/${submissionId}`),
  closeRoom: (roomId: string) => request<{ roomId: string; status: "closed" }>("POST", `/rooms/${roomId}/close`),
  submit: (body: CreateSubmissionRequest, idempotencyKey: string) =>
    request<CreateSubmissionResponse>("POST", "/submissions", body, { "idempotency-key": idempotencyKey }),

  // Question authoring (owner-only except `questions`)
  myQuestions: () => request<MyQuestionSummary[]>("GET", "/questions/mine"),
  question: (id: string) => request<QuestionDetail>("GET", `/questions/${id}`),
  generateQuestion: (brief: string) => request<QuestionDetail>("POST", "/questions/generate", { brief }),
  createQuestion: (title?: string) => request<QuestionDetail>("POST", "/questions", title ? { title } : {}),
  saveDraft: (id: string, draft: QuestionDraftInput) => request<QuestionDetail>("PUT", `/questions/${id}/draft`, draft),
  discardDraft: (id: string, revision: number) =>
    request<QuestionDetail>("DELETE", `/questions/${id}/draft`, { revision }),
  publishQuestion: (id: string, revision: number) =>
    request<QuestionDetail>("POST", `/questions/${id}/publish`, { revision }),
  deleteQuestion: (id: string, revision: number) => request<void>("DELETE", `/questions/${id}`, { revision }),
  previewQuestion: (id: string, of: "draft" | "latest") =>
    request<CandidateQuestionView>("GET", `/questions/${id}/preview?of=${of}`),
};

/** The room already has its candidate (409 `room_full`, ADR 0012). */
export const isRoomFull = (err: unknown) =>
  err instanceof ApiError && err.status === 409 && (err.body as { conflict?: unknown } | null)?.conflict === "room_full";

/** No response, or a server-side failure: the request may or may not have been applied. */
export const isRetryable = (err: unknown) => !(err instanceof ApiError) || err.status >= 500;

/**
 * Submit with automatic retries that all carry the SAME idempotency key, so whichever attempt the
 * server actually received, at most one submission exists. 4xx responses are final and not retried.
 */
export async function submitWithRetry(body: CreateSubmissionRequest, idempotencyKey: string, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await api.submit(body, idempotencyKey);
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) throw err;
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
    }
  }
}
