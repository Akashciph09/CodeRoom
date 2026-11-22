import { AuthClient, type Session } from "@supabase/auth-js";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./config";

/**
 * One identity per tab, so an interviewer and a candidate can be tried side by side in one browser.
 * Two things are needed for that: sessionStorage (per-tab storage) AND a per-tab storage key —
 * auth-js syncs sessions across tabs over a BroadcastChannel named after the storage key.
 */
function tabStorageKey() {
  let id = sessionStorage.getItem("coderoom-tab");
  if (!id) {
    id = crypto.randomUUID().slice(0, 8);
    sessionStorage.setItem("coderoom-tab", id);
  }
  return `coderoom-auth-${id}`;
}

/** Supabase is used for sign-in only (no table access from the browser — ADR 0006). */
export const auth = new AuthClient({
  url: `${SUPABASE_URL}/auth/v1`,
  headers: { apikey: SUPABASE_PUBLISHABLE_KEY },
  storageKey: tabStorageKey(),
  storage: window.sessionStorage,
  persistSession: true,
  autoRefreshToken: true,
  detectSessionInUrl: false,
});

export async function getAccessToken(): Promise<string> {
  const { data } = await auth.getSession();
  if (!data.session) throw new Error("Not signed in");
  return data.session.access_token;
}

export function displayName(session: Session): string {
  const meta = session.user.user_metadata as { name?: string } | undefined;
  return meta?.name?.trim() || session.user.email?.split("@")[0] || "Anonymous";
}

interface SessionState {
  session: Session | null;
  loading: boolean;
}

const SessionContext = createContext<SessionState>({ session: null, loading: true });

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ session: null, loading: true });

  useEffect(() => {
    auth.getSession().then(({ data }) => setState({ session: data.session, loading: false }));
    const { data } = auth.onAuthStateChange((_event, session) => setState({ session, loading: false }));
    return () => data.subscription.unsubscribe();
  }, []);

  return <SessionContext.Provider value={state}>{children}</SessionContext.Provider>;
}

export const useSession = () => useContext(SessionContext);
