'use client';

/**
 * BlockSuite DocEditor — React wrapper for the Lit-based BlockSuite editor.
 *
 * Ported from the original's components/doc-composer/doc-editor.tsx, but
 * uses the imperative appendChild pattern (from the official BlockSuite
 * react-basic-next example) instead of @afk/component's
 * createReactComponentFromLit bridge (which is an Entry-internal package
 * we don't have).
 *
 * BlockSuite is Lit-based (web components) — it CANNOT run during SSR.
 * This component is 'use client' and must be dynamically imported with
 * { ssr: false } by parent pages.
 */

import { ViewportElementExtension } from '@blocksuite/affine/shared/services';
import type { Store, ExtensionType } from '@blocksuite/affine/store';
import { BlockStdScope, EditorHost } from '@blocksuite/affine/std';
import { useEffect, useMemo, useRef } from 'react';

import { getComposerViewManager } from '@/lib/blocksuite/specs';

// Register the custom element once
let _registered = false;
function ensureRegistered() {
  if (!_registered && typeof customElements !== 'undefined') {
    if (!customElements.get('editor-host')) {
      // EditorHost registers itself when imported; just ensure the side effect
    }
    _registered = true;
  }
}

interface DocEditorProps {
  readonly?: boolean;
  doc: Store;
  onChange?: () => void;
}

export function DocEditor({ readonly, doc, onChange }: DocEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stdRef = useRef<BlockStdScope | null>(null);
  const currentHostRef = useRef<EditorHost | null>(null);

  const specs = useMemo<ExtensionType[]>(() => {
    const manager = getComposerViewManager();
    return manager
      .get(readonly ? 'preview-page' : 'page')
      .concat([ViewportElementExtension('.bs-editor-viewport')]);
  }, [readonly]);

  useEffect(() => {
    ensureRegistered();

    if (!containerRef.current || !doc) return;

    // Create a new BlockStdScope for this doc
    const std = new BlockStdScope({
      store: doc,
      extensions: specs,
    });
    stdRef.current = std;

    // Render the EditorHost (a Lit element) imperatively
    const host = std.render();
    if (host instanceof Node) {
      containerRef.current.innerHTML = '';
      containerRef.current.appendChild(host);
      currentHostRef.current = host as EditorHost;
    }

    return () => {
      if (containerRef.current) {
        containerRef.current.innerHTML = '';
      }
      currentHostRef.current = null;
      stdRef.current = null;
    };
  }, [doc, specs]);

  // Subscribe to block updates for onChange
  useEffect(() => {
    if (!doc || !onChange) return;
    const subscription = doc.slots.blockUpdated?.subscribe(() => {
      onChange();
    });
    return () => {
      subscription?.unsubscribe();
    };
  }, [doc, onChange]);

  return (
    <div className="bs-editor-viewport h-full">
      <div ref={containerRef} className="page-editor-container h-full" />
    </div>
  );
}
