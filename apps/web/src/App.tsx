import { lazy, Suspense, type ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { SessionProvider, useSession } from "./lib/auth";
import { AuthPage } from "./pages/AuthPage";
import { HomePage } from "./pages/HomePage";
import { JoinPage } from "./pages/JoinPage";
import { QuestionEditorPage } from "./pages/QuestionEditorPage";
import { QuestionsPage } from "./pages/QuestionsPage";

// Monaco + Yjs are most of the bundle; only load them when a room is opened.
const RoomPage = lazy(() => import("./pages/RoomPage").then((m) => ({ default: m.RoomPage })));

function RequireAuth({ children }: { children: ReactNode }) {
  const { session, loading } = useSession();
  const location = useLocation();
  if (loading) return <div className="center muted">Loading…</div>;
  if (!session) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  return <>{children}</>;
}

export function App() {
  return (
    <SessionProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<AuthPage />} />
          <Route path="/" element={<RequireAuth><HomePage /></RequireAuth>} />
          <Route path="/join/:inviteCode" element={<RequireAuth><JoinPage /></RequireAuth>} />
          <Route path="/questions" element={<RequireAuth><QuestionsPage /></RequireAuth>} />
          <Route path="/questions/:questionId" element={<RequireAuth><QuestionEditorPage /></RequireAuth>} />
          <Route
            path="/rooms/:roomId"
            element={
              <RequireAuth>
                <Suspense fallback={<div className="center muted">Loading editor…</div>}>
                  <RoomPage />
                </Suspense>
              </RequireAuth>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </SessionProvider>
  );
}
