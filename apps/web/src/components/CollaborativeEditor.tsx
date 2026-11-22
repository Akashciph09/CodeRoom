import { useEffect, useRef } from "react";
import { MonacoBinding } from "y-monaco";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import type { Language } from "@coderoom/shared";
import { monaco } from "../lib/monaco";

interface Props {
  text: Y.Text;
  awareness: Awareness;
  language: Language;
  readOnly?: boolean;
}

/** Monaco bound to a Y.Text. Remote cursors/selections come from awareness (styled in RemoteCursorStyles). */
export function CollaborativeEditor({ text, awareness, language, readOnly = false }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

  useEffect(() => {
    const editor = monaco.editor.create(container.current!, {
      language,
      theme: "vs-dark",
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 14,
      tabSize: 4,
      scrollBeyondLastLine: false,
      readOnly,
    });
    editorRef.current = editor;
    const binding = new MonacoBinding(text, editor.getModel()!, new Set([editor]), awareness);
    return () => {
      binding.destroy();
      editor.dispose();
      editorRef.current = null;
    };
    // The editor is created once per Y.Text; language/readOnly are updated below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, awareness]);

  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (model) monaco.editor.setModelLanguage(model, language);
  }, [language]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly]);

  return <div className="editor" ref={container} />;
}
