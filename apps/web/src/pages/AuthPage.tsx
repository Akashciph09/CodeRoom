import { useState, type FormEvent } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { auth, useSession } from "../lib/auth";

export function AuthPage() {
  const { session } = useSession();
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (session) return <Navigate to={next} replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } =
      mode === "signin"
        ? await auth.signInWithPassword({ email, password })
        : await auth.signUp({ email, password, options: { data: { name: name.trim() } } });
    setBusy(false);
    if (error) setError(error.message);
  }

  return (
    <div className="auth-page">
      <form className="card auth-card" onSubmit={onSubmit}>
        <h1 className="brand">
          Code<span>Room</span>
        </h1>
        <p className="muted">Live technical interviews with sandboxed code execution.</p>

        <div className="tabs">
          <button type="button" className={mode === "signin" ? "active" : ""} onClick={() => setMode("signin")}>
            Sign in
          </button>
          <button type="button" className={mode === "signup" ? "active" : ""} onClick={() => setMode("signup")}>
            Create account
          </button>
        </div>

        {mode === "signup" && (
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />
          </label>
        )}
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={6}
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
          />
        </label>

        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy}>
          {busy ? "…" : mode === "signin" ? "Sign in" : "Create account"}
        </button>
      </form>
    </div>
  );
}

/** Only allow same-site relative redirects. */
function safeNext(next: string | null) {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}
