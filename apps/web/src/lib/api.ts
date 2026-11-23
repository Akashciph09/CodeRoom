import type {
  CandidateQuestionView,
  CandidateSubmissionView,
  CreateRoomResponse,
  CreateSubmissionRequest,
  CreateSubmissionResponse,
  InterviewerSubmissionView,
  JoinRoomResponse,
  MyQuestionSummary,
  PublishProblem,
  QuestionDetail,
  QuestionDraftInput,
  QuestionSummary,
  RoomSummary,
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
  createRoom: (questionIds: string[]) => request<CreateRoomResponse>("POST", "/rooms", { questionIds }),
  revealQuestion: (roomId: string, roomQuestionId: string) =>
    request<{ roomQuestionId: string; revealed: true }>("POST", `/rooms/${roomId}/questions/${roomQuestionId}/reveal`),
  joinRoom: (inviteCode: string) => request<JoinRoomResponse>("POST", "/rooms/join", { inviteCode }),
  room: (roomId: string) => request<RoomView>("GET", `/rooms/${roomId}`),
  roomSubmissions: (roomId: string) => request<SubmissionView[]>("GET", `/rooms/${roomId}/submissions`),
  closeRoom: (roomId: string) => request<{ roomId: string; status: "closed" }>("POST", `/rooms/${roomId}/close`),
  submit: (body: CreateSubmissionRequest, idempotencyKey: string) =>
    request<CreateSubmissionResponse>("POST", "/submissions", body, { "idempotency-key": idempotencyKey }),

  // Question authoring (owner-only except `questions`)
  myQuestions: () => request<MyQuestionSummary[]>("GET", "/questions/mine"),
  question: (id: string) => request<QuestionDetail>("GET", `/questions/${id}`),
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
