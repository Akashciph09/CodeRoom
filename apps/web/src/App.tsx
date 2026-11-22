import Editor from "@monaco-editor/react";
import { useEffect, useState } from "react";
import type { Language } from "@coderoom/shared";

const STARTER: Record<Language, string> = {
  python: "import sys\n\nfor line in sys.stdin:\n    print(line.strip())\n",
  javascript:
    "const lines = require('fs').readFileSync(0, 'utf8').trim().split('\\n');\nfor (const l of lines) console.log(l);\n",
};

export function App() {
  const [language, setLanguage] = useState<Language>("python");
  const [health, setHealth] = useState<string>("checking…");

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((j: { ok: boolean }) => setHealth(j.ok ? "api ok" : "api degraded"))
      .catch(() => setHealth("api unreachable"));
  }, []);

  // TODO (build step 4): rooms, roles, Yjs-bound editor, run/submit, live results.
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", fontFamily: "system-ui" }}>
      <header style={{ display: "flex", gap: 12, alignItems: "center", padding: "8px 16px" }}>
        <strong>CodeRoom</strong>
        <select value={language} onChange={(e) => setLanguage(e.target.value as Language)}>
          <option value="python">Python</option>
          <option value="javascript">JavaScript</option>
        </select>
        <span style={{ marginLeft: "auto", opacity: 0.6 }}>{health}</span>
      </header>
      <Editor height="100%" language={language} value={STARTER[language]} theme="vs-dark" />
    </div>
  );
}
