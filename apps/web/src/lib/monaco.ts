/**
 * Monaco is bundled locally (no CDN loader) and imported from the exact module y-monaco uses,
 * so the editor and the Yjs binding share one Monaco instance.
 */
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import "monaco-editor/esm/vs/editor/edcore.main.js"; // editor features: find, folding, bracket matching…
import "monaco-editor/esm/vs/basic-languages/python/python.contribution.js";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

self.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

export { monaco };
