import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { TopBar } from "../components/TopBar";
import { api, ApiError } from "../lib/api";

/** Invite links land here: /join/<code>. Joining grants the candidate role. */
export function JoinPage() {
  const { inviteCode = "" } = useParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // StrictMode runs effects twice in dev
    started.current = true;
    api
      .joinRoom(inviteCode)
      .then(({ roomId }) => navigate(`/rooms/${roomId}`, { replace: true }))
      .catch((err: Error) =>
        setError(
          err instanceof ApiError && err.status === 409 && /candidate/.test(err.message)
            ? "This interview already has a candidate. Each interview is one interviewer and one candidate — ask the interviewer for your own interview link."
            : err.message,
        ),
      );
  }, [inviteCode, navigate]);

  return (
    <>
      <TopBar />
      <main className="center">
        {error ? (
          <div className="card">
            <p className="error">Couldn't join: {error}</p>
            <Link to="/">Back home</Link>
          </div>
        ) : (
          <p className="muted">Joining room…</p>
        )}
      </main>
    </>
  );
}
