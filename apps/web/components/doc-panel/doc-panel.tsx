'use client';

import dynamic from 'next/dynamic';
import { CloseIcon } from '@blocksuite/icons/rc';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Store } from '@blocksuite/affine/store';

import { snapshotHelper } from '@/lib/blocksuite/snapshot-helper';

// BlockSuite editor is client-only — no SSR
const DocEditor = dynamic(() => import('@/components/doc-editor').then(m => m.DocEditor), {
  ssr: false,
  loading: () => (
    <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
      Loading editor...
    </div>
  ),
});

// PresentationMode transitively imports real BlockSuite runtime modules
// (Text, replaceIdMiddleware) — not just types — so it must go through the
// same client-only dynamic-import boundary as DocEditor above, or its
// module graph (which pulls in @blocksuite/affine-block-note, a package
// that calls vanilla-extract's style() at module-eval time with no
// vanilla-extract webpack plugin configured) gets statically included in
// the server bundle and breaks static prerendering of any page that (even
// conditionally) renders DocPanel.
const PresentationMode = dynamic(() => import('./presentation-mode').then(m => m.PresentationMode), {
  ssr: false,
});

interface DocPanelProps {
  docId: string;
  onOpenChat?: () => void;
  onClose?: () => void;
}

type DocLoadState =
  | { status: 'loading' }
  | { status: 'success'; doc: Store; title: string }
  | { status: 'error'; error: string };

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export function DocPanel({ docId, onOpenChat, onClose }: DocPanelProps) {
  const [state, setState] = useState<DocLoadState>({ status: 'loading' });
  const [editing, setEditing] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [presenting, setPresenting] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTemp = docId.startsWith('temp-');

  useEffect(() => {
    const loadDocument = async () => {
      try {
        setState({ status: 'loading' });

        // Inline chat-generated docs (doc_compose/make_it_real results with no
        // persisted docId yet) are stashed in sessionStorage by DocCard under a
        // `temp-<timestamp>` key — check that first instead of hitting the API,
        // which would 404 for these (real bug, fixed here: DocCard.openDoc(tempId)
        // previously had nowhere that actually read the stash back out).
        if (docId.startsWith('temp-')) {
          const raw = sessionStorage.getItem(`doc:${docId}`);
          if (!raw) {
            setState({ status: 'error', error: 'This preview has expired — it only lives for the current browser session.' });
            return;
          }
          const { content, title } = JSON.parse(raw) as { content: string; title?: string };
          const store = await snapshotHelper.createStore(content || `# ${title || 'Untitled'}\n\nEmpty document`);
          if (store) {
            setState({ status: 'success', doc: store, title: title || 'Untitled' });
          } else {
            setState({ status: 'error', error: 'Failed to create document' });
          }
          return;
        }

        // Fetch the document from our copilot docs API
        const res = await fetch(`/api/copilot/docs/${docId}`);
        if (!res.ok) {
          setState({ status: 'error', error: `Document not found` });
          return;
        }
        const data = await res.json();
        const content = data.content || `# ${data.title || 'Untitled'}\n\nEmpty document`;
        const title = data.title || 'Untitled';

        const store = await snapshotHelper.createStore(content);
        if (store) {
          setState({ status: 'success', doc: store, title });
        } else {
          setState({ status: 'error', error: 'Failed to create document' });
        }
      } catch (err) {
        console.error('Error loading document:', err);
        setState({ status: 'error', error: 'Failed to load document' });
      }
    };

    loadDocument();
    setEditing(false);
    setSaveStatus('idle');
  }, [docId]);

  // Debounced autosave: on every block change, convert the BlockSuite doc back
  // to markdown and PATCH it to /api/copilot/docs/:docId. Real docs only —
  // temp (chat-generated, unpersisted) docs have nowhere to save to yet.
  const handleChange = useCallback(() => {
    if (isTemp || state.status !== 'success') return;
    setSaveStatus('saving');
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      try {
        const markdown = await snapshotHelper.docToMarkdown(state.doc);
        const res = await fetch(`/api/copilot/docs/${docId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: markdown }),
        });
        setSaveStatus(res.ok ? 'saved' : 'error');
      } catch (err) {
        console.error('Failed to save document:', err);
        setSaveStatus('error');
      }
    }, 800);
  }, [docId, isTemp, state]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  if (state.status === 'loading') {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
        Loading document...
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="h-full flex items-center justify-center text-destructive text-sm">
        {state.error}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border h-15">
        <h2 className="text-xl font-semibold text-foreground truncate">
          {state.title}
        </h2>
        <div className="flex items-center gap-3">
          {!isTemp && editing && (
            <span className="text-xs text-muted-foreground">
              {saveStatus === 'saving' ? 'Saving…' : saveStatus === 'saved' ? 'Saved' : saveStatus === 'error' ? 'Failed to save' : ''}
            </span>
          )}
          <button
            onClick={() => setPresenting(true)}
            title="Present"
            className="inline-flex items-center justify-center rounded-md text-sm font-medium border border-input bg-card hover:bg-accent transition-colors h-8 px-3"
          >
            Present
          </button>
          {onOpenChat && (
            <button
              onClick={onOpenChat}
              title="Chat about this document"
              className="inline-flex items-center justify-center rounded-md text-sm font-medium border border-input bg-card hover:bg-accent transition-colors h-8 px-3"
            >
              Chat
            </button>
          )}
          {!isTemp && (
            <button
              onClick={() => setEditing(e => !e)}
              className="inline-flex items-center justify-center rounded-md text-sm font-medium border border-input bg-card hover:bg-accent transition-colors h-8 px-3"
            >
              {editing ? 'Done' : 'Edit'}
            </button>
          )}
          {onClose && (
            <button
              onClick={onClose}
              title="Close document"
              className="p-1 rounded hover:bg-accent transition-colors"
            >
              <CloseIcon className="w-5 h-5 text-muted-foreground" />
            </button>
          )}
        </div>
      </div>

      {/* Document content */}
      <div className="flex-1 overflow-auto rounded py-2 px-6">
        <DocEditor doc={state.doc} readonly={!editing} onChange={editing ? handleChange : undefined} />
      </div>

      {presenting && <PresentationMode doc={state.doc} onClose={() => setPresenting(false)} />}
    </div>
  );
}

/**
 * Inline doc panel — renders a doc directly from markdown content
 * (used by chat tool results like doc_compose which generate content
 * without a persisted doc ID).
 */
export function InlineDocPanel({ content, title, onClose }: { content: string; title?: string; onClose?: () => void }) {
  const [state, setState] = useState<{ status: 'loading' | 'success' | 'error'; doc?: Store }>({ status: 'loading' });

  useEffect(() => {
    snapshotHelper
      .createStore(content)
      .then(store => {
        if (store) {
          setState({ status: 'success', doc: store });
        } else {
          setState({ status: 'error' });
        }
      })
      .catch(() => setState({ status: 'error' }));
  }, [content]);

  return (
    <div className="h-full flex flex-col gap-4">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border h-15">
        <h2 className="text-xl font-semibold text-foreground truncate">
          {title || 'Generated Document'}
        </h2>
        {onClose && (
          <button
            onClick={onClose}
            title="Close document"
            className="p-1 rounded hover:bg-accent transition-colors"
          >
            <CloseIcon className="w-5 h-5 text-muted-foreground" />
          </button>
        )}
      </div>
      <div className="flex-1 overflow-auto rounded py-2 px-6">
        {state.status === 'loading' && (
          <div className="text-muted-foreground text-sm">Loading...</div>
        )}
        {state.status === 'error' && (
          <div className="text-destructive text-sm">Failed to render document</div>
        )}
        {state.status === 'success' && state.doc && (
          <DocEditor doc={state.doc} readonly={true} />
        )}
      </div>
    </div>
  );
}
