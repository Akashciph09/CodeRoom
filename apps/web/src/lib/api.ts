import type {
  CandidateSubmissionView,
  CreateRoomResponse,
  CreateSubmissionRequest,
  CreateSubmissionResponse,
  InterviewerSubmissionView,
  JoinRoomResponse,
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
  ) {
    super(message);
  }
}

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
  if (!res.ok) throw new ApiError(res.status, (json as { error?: string } | null)?.error ?? res.statusText);
  return json as T;
}

export const api = {
  questions: () => request<QuestionSummary[]>("GET", "/questions"),
  myRooms: () => request<RoomSummary[]>("GET", "/rooms"),
  createRoom: (questionId: string) => request<CreateRoomResponse>("POST", "/rooms", { questionId }),
  joinRoom: (inviteCode: string) => request<JoinRoomResponse>("POST", "/rooms/join", { inviteCode }),
  room: (roomId: string) => request<RoomView>("GET", `/rooms/${roomId}`),
  roomSubmissions: (roomId: string) => request<SubmissionView[]>("GET", `/rooms/${roomId}/submissions`),
  closeRoom: (roomId: string) => request<{ roomId: string; status: "closed" }>("POST", `/rooms/${roomId}/close`),
  submit: (body: CreateSubmissionRequest, idempotencyKey: string) =>
    request<CreateSubmissionResponse>("POST", "/submissions", body, { "idempotency-key": idempotencyKey }),
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
