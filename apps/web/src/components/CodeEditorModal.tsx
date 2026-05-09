import { useEffect, useRef, useState } from "react";

type Lang = "bash" | "template";

interface Props {
  title: string;
  value: string;
  language: Lang;
  hint?: string;
  onSave: (next: string) => void;
  onClose: () => void;
}

const BASH_KEYWORDS = new Set([
  "if", "then", "else", "elif", "fi", "for", "do", "done", "while", "until",
  "case", "esac", "in", "function", "return", "exit", "local", "export",
  "declare", "readonly", "set", "unset", "shift", "break", "continue",
]);

const COMMON_CMDS = new Set([
  "echo", "cat", "grep", "sed", "awk", "find", "ls", "cd", "rm", "mv", "cp",
  "mkdir", "rmdir", "touch", "chmod", "chown", "kill", "ps", "test",
  "composer", "npm", "pnpm", "yarn", "make", "git", "vendor", "phpstan",
  "phpunit", "vitest", "pytest", "cargo", "go", "docker", "curl", "wget",
]);

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Tiny bash highlighter — token-pass via single regex with alternation. */
function highlightBash(src: string): string {
  // Order: comments, strings, vars, numbers, keywords, operators.
  const RE = /(#[^\n]*)|('(?:[^'\\\n]|\\.)*'?)|("(?:[^"\\\n]|\\.)*"?)|(\$\{[^}\n]*\}|\$[A-Za-z_]\w*|\$\d)|(\b\d+\b)|(\b[A-Za-z_][\w-]*\b)|(&&|\|\||;;|;|\||>>|<<|>|<|`)/g;
  const out: string[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(src))) {
    if (m.index > last) out.push(escapeHtml(src.slice(last, m.index)));
    let cls = "";
    if (m[1]) cls = "tk-comment";
    else if (m[2] || m[3]) cls = "tk-string";
    else if (m[4]) cls = "tk-var";
    else if (m[5]) cls = "tk-num";
    else if (m[6]) {
      const w = m[6];
      if (BASH_KEYWORDS.has(w)) cls = "tk-keyword";
      else if (COMMON_CMDS.has(w)) cls = "tk-cmd";
    }
    else if (m[7]) cls = "tk-op";
    const escaped = escapeHtml(m[0]);
    out.push(cls ? `<span class="${cls}">${escaped}</span>` : escaped);
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push(escapeHtml(src.slice(last)));
  // Trailing newline must take vertical space in the <pre>.
  return out.join("") + (src.endsWith("\n") ? "\n " : "");
}

/** Highlight {placeholders} in templates. */
function highlightTemplate(src: string): string {
  const RE = /\{[a-z_]+\}/g;
  const out: string[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(src))) {
    if (m.index > last) out.push(escapeHtml(src.slice(last, m.index)));
    out.push(`<span class="tk-placeholder">${escapeHtml(m[0])}</span>`);
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push(escapeHtml(src.slice(last)));
  return out.join("") + (src.endsWith("\n") ? "\n " : "");
}

function highlight(src: string, lang: Lang): string {
  return lang === "bash" ? highlightBash(src) : highlightTemplate(src);
}

export function CodeEditorModal({ title, value, language, hint, onSave, onClose }: Props) {
  const [draft, setDraft] = useState(value);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    taRef.current?.focus();
    // Place caret at end.
    const ta = taRef.current;
    if (ta) ta.setSelectionRange(ta.value.length, ta.value.length);
  }, []);

  // Keep pre scroll synced with textarea.
  function syncScroll() {
    if (preRef.current && taRef.current) {
      preRef.current.scrollTop = taRef.current.scrollTop;
      preRef.current.scrollLeft = taRef.current.scrollLeft;
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Cmd/Ctrl+Enter saves.
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      onSave(draft);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    // Tab inserts two spaces instead of moving focus.
    if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      const ta = taRef.current!;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const next = draft.slice(0, start) + "  " + draft.slice(end);
      setDraft(next);
      requestAnimationFrame(() => {
        ta.setSelectionRange(start + 2, start + 2);
      });
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="code-modal" onClick={(e) => e.stopPropagation()}>
        <div className="code-modal-header">
          <h3>
            {title}
            <span className="lang-pill">{language === "bash" ? "shell" : "template"}</span>
          </h3>
          <button onClick={onClose} title="Close (Esc)" style={{ background: "transparent", border: 0, fontSize: 18, cursor: "pointer" }}>×</button>
        </div>
        <div className="code-modal-body">
          <div className="code-editor-wrap">
            <pre
              ref={preRef}
              aria-hidden="true"
              dangerouslySetInnerHTML={{ __html: highlight(draft, language) }}
            />
            <textarea
              ref={taRef}
              value={draft}
              onChange={(e) => { setDraft(e.target.value); }}
              onScroll={syncScroll}
              onKeyDown={handleKeyDown}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
            />
          </div>
        </div>
        <div className="code-modal-footer">
          <div className="hint">
            {hint ?? (language === "bash"
              ? "Runs via bash -lc in the run worktree. Tab inserts 2 spaces. ⌘/Ctrl + Enter to save."
              : "Placeholders in {curly_braces} are filled at run time. ⌘/Ctrl + Enter to save.")}
          </div>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => onSave(draft)}>Save</button>
        </div>
      </div>
    </div>
  );
}
