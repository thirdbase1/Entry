'use client';

/**
 * Real syntax-highlighted, editable code view for the Files tab
 * (2026-07-14, "full coding environment" push -- explicit ask: "we are
 * fixing this stuff from their coding platform like VS Code" — a plain
 * `<pre>` text dump was never going to clear that bar). `@monaco-editor/react`
 * ships the actual Monaco editor (the same editor VS Code itself is built
 * on) as a self-contained npm package with zero extra webpack config
 * needed under Next.js -- loaded here via `dynamic(..., { ssr: false })`
 * since Monaco needs a real DOM/worker environment and can't run during
 * Next's server render pass.
 */
import dynamic from 'next/dynamic';
import { useState } from 'react';

const Editor = dynamic(() => import('@monaco-editor/react'), { ssr: false, loading: () => <div className="text-xs text-muted-foreground p-3">Loading editor…</div> });

const EXT_TO_LANGUAGE: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  py: 'python',
  rs: 'rust',
  go: 'go',
  css: 'css',
  scss: 'scss',
  html: 'html',
  md: 'markdown',
  mdx: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  sh: 'shell',
  bash: 'shell',
  sql: 'sql',
  prisma: 'prisma',
  toml: 'toml',
  env: 'shell',
};

export function languageForPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return EXT_TO_LANGUAGE[ext] ?? 'plaintext';
}

export function CodeEditor({
  path,
  content,
  readOnly,
  onSave,
}: {
  path: string;
  content: string;
  readOnly: boolean;
  onSave: (newContent: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(content);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirty = draft !== content;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save this file.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 min-h-0">
        <Editor
          height="100%"
          path={path}
          language={languageForPath(path)}
          value={draft}
          onChange={value => setDraft(value ?? '')}
          theme="vs-dark"
          options={{
            readOnly,
            minimap: { enabled: false },
            fontSize: 12,
            wordWrap: 'on',
            scrollBeyondLastLine: false,
          }}
        />
      </div>
      {!readOnly && (
        <div className="h-9 border-t border-border px-3 flex items-center justify-between shrink-0 text-xs">
          <span className="text-muted-foreground">
            {error ? <span className="text-red-500">{error}</span> : dirty ? 'Unsaved changes' : savedAt ? 'Saved' : 'No changes'}
          </span>
          <button
            onClick={save}
            disabled={!dirty || saving}
            className="px-2.5 py-1 rounded-sm bg-primary text-primary-foreground disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </div>
  );
}
