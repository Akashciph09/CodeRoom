import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { auth, displayName, useSession } from "../lib/auth";

export function TopBar({ children }: { children?: ReactNode }) {
  const { session } = useSession();
  return (
    <header className="topbar">
      <Link to="/" className="brand small">
        Code<span>Room</span>
      </Link>
      <div className="topbar-center">{children}</div>
      {session && (
        <div className="topbar-user">
          <span className="muted">{displayName(session)}</span>
          <button className="ghost" onClick={() => auth.signOut()}>
            Sign out
          </button>
        </div>
      )}
    </header>
  );
}
