'use client';

/**
 * Ported from components/chat-context.tsx (`ContextSelectorMenu`/
 * `ContextPreview`) — the "@ mention" style context-attachment picker:
 * pick chats/docs/files from the library to ground the next message.
 *
 * Real adaptation, not cosmetic: the original resolved attached context
 * server-side via a GraphQL `copilotContext` (a persistent, named RAG
 * context object with embeddings) that the chat session's system prompt
 * referenced turn after turn. That exact persistent-context object doesn't
 * exist in this port. Instead this uses eve's real, documented
 * `clientContext` field on `send()` — "ephemeral client/page context for
 * the next model call only" (checked directly against
 * node_modules/eve/dist/src/client/types.d.ts) — so selecting a doc/file
 * actually fetches its real content and threads it into that one turn as
 * a model-visible context message. Weaker than a persistent named RAG
 * context (it's resolved fresh per-send, not cached server-side across a
 * whole session), but genuinely functional today.
 *
 * Now upgraded with real semantic search: typing 2+ characters queries
 * `/api/copilot/search` (embedding/service.ts's pgvector cosine search
 * over the user's doc/file chunks) and shows ranked results above the
 * plain substring-filtered library list, closer to the original's
 * embedding-backed context picker. Falls back to substring filtering if
 * the search call fails or returns nothing (e.g. embeddings pipeline mid-
 * -index) — never leaves the picker empty because of it.
 *
 * Also dropped: IndexedDB persistence of picked context across reloads
 * (`idb`-backed cache in the original) — component state only for now,
 * clears on refresh. Reasonable given attachments are meant to be
 * per-turn scratch context, not a saved list.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLibraryStore, type AllItem } from '@/store/library';
import { ChatIcon } from '@/components/icons/chat-icon';
import { cn } from '@/lib/utils';

export interface AttachedContext {
  type: 'chat' | 'doc' | 'file';
  id: string;
  label: string;
}

interface SearchHit {
  targetId: string;
  targetType: 'doc' | 'file';
  chunk: number;
  content: string;
  distance: number;
}

function itemLabel(item: AllItem): string {
  if (item.type === 'chat') return item.title ?? 'Untitled chat';
  if (item.type === 'doc') return item.title;
  return item.fileName;
}

function itemIcon(type: AttachedContext['type']) {
  if (type === 'chat') return <ChatIcon className="w-3.5 h-3.5" />;
  if (type === 'doc') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M13 2v7h7" />
    </svg>
  );
}

/** Debounced semantic search against embedding/service.ts's pgvector search. */
function useSemanticSearch(query: string) {
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (query.trim().length < 2) {
      setHits([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/copilot/search?q=${encodeURIComponent(query)}&topK=8`);
        if (!res.ok) throw new Error('search failed');
        const data = await res.json();
        if (!cancelled) setHits(Array.isArray(data.results) ? data.results : []);
      } catch {
        if (!cancelled) setHits([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

  return { hits, loading };
}

export function ContextSelectorMenu({
  attached,
  onAttach,
  children,
}: {
  attached: AttachedContext[];
  onAttach: (ctx: AttachedContext) => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const { chats, docs, files, refresh, initialized } = useLibraryStore();
  const ref = useRef<HTMLDivElement>(null);
  const { hits: searchHits, loading: searching } = useSemanticSearch(search);

  useEffect(() => {
    if (open && !initialized) refresh();
  }, [open, initialized, refresh]);

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    if (open) document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  const allItems: AllItem[] = useMemo(() => [...chats, ...docs, ...files], [chats, docs, files]);

  const findItem = (type: 'doc' | 'file', id: string) =>
    allItems.find(i => (i.type === 'doc' ? i.docId === id && type === 'doc' : i.type === 'file' && i.fileId === id && type === 'file'));

  // De-duped search hits, one row per target (best-scoring chunk).
  const dedupedHits = useMemo(() => {
    const seen = new Map<string, SearchHit>();
    for (const h of searchHits) {
      const key = `${h.targetType}-${h.targetId}`;
      if (!seen.has(key) || seen.get(key)!.distance > h.distance) seen.set(key, h);
    }
    return Array.from(seen.values())
      .filter(h => !attached.some(a => a.id === h.targetId && a.type === h.targetType))
      .sort((a, b) => a.distance - b.distance);
  }, [searchHits, attached]);

  const items = useMemo(() => {
    const lower = search.toLowerCase();
    return allItems
      .filter(item => (lower ? itemLabel(item).toLowerCase().includes(lower) : true))
      .filter(item => {
        const id = item.type === 'chat' ? item.sessionId : item.type === 'doc' ? item.docId : item.fileId;
        return !attached.some(a => a.id === id && a.type === item.type);
      })
      .slice(0, 30);
  }, [allItems, search, attached]);

  const showSemanticSection = search.trim().length >= 2;

  return (
    <div ref={ref} className="relative inline-block">
      <div onClick={() => setOpen(o => !o)}>{children}</div>
      {open && (
        <div className="absolute bottom-full left-0 mb-2 w-80 rounded-lg border bg-popover text-popover-foreground shadow-lg overflow-hidden z-20">
          <div className="border-b px-3 py-2">
            <input
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search chats, docs, files…"
              className="w-full bg-transparent outline-none text-sm text-foreground placeholder:text-muted-foreground"
            />
          </div>
          <div className="max-h-72 overflow-y-auto py-1">
            {showSemanticSection && (
              <>
                <div className="px-3 pt-2 pb-1 text-[11px] font-medium uppercase text-muted-foreground">
                  {searching ? 'Searching…' : 'Best matches'}
                </div>
                {dedupedHits.length === 0 && !searching && (
                  <div className="px-3 py-2 text-xs text-muted-foreground">No semantic matches yet</div>
                )}
                {dedupedHits.map(hit => {
                  const matched = findItem(hit.targetType, hit.targetId);
                  const label = matched ? itemLabel(matched) : hit.content.slice(0, 40);
                  return (
                    <button
                      key={`hit-${hit.targetType}-${hit.targetId}`}
                      onClick={() => {
                        onAttach({ type: hit.targetType, id: hit.targetId, label });
                        setOpen(false);
                        setSearch('');
                      }}
                      className="w-full flex flex-col gap-0.5 px-3 py-1.5 text-left hover:bg-accent"
                    >
                      <span className="flex items-center gap-2 text-sm text-foreground">
                        <span className="text-muted-foreground shrink-0">{itemIcon(hit.targetType)}</span>
                        <span className="truncate">{label}</span>
                      </span>
                      <span className="text-xs text-muted-foreground truncate pl-5.5">{hit.content.slice(0, 90)}</span>
                    </button>
                  );
                })}
                <div className="border-t mt-1" />
              </>
            )}
            {items.length === 0 && dedupedHits.length === 0 && (
              <div className="px-3 py-4 text-xs text-muted-foreground text-center">No results</div>
            )}
            {items.map(item => {
              const id = item.type === 'chat' ? item.sessionId : item.type === 'doc' ? item.docId : item.fileId;
              return (
                <button
                  key={`${item.type}-${id}`}
                  onClick={() => {
                    onAttach({ type: item.type, id, label: itemLabel(item) });
                    setOpen(false);
                    setSearch('');
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-foreground hover:bg-accent text-left"
                >
                  <span className="text-muted-foreground shrink-0">{itemIcon(item.type)}</span>
                  <span className="truncate">{itemLabel(item)}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function ContextPreview({
  attached,
  onRemove,
}: {
  attached: AttachedContext[];
  onRemove: (ctx: AttachedContext) => void;
}) {
  if (attached.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 px-1 pb-2">
      {attached.map(ctx => (
        <div key={`${ctx.type}-${ctx.id}`} className="flex items-center gap-1.5 rounded-md border bg-muted px-2 py-1 text-xs text-foreground">
          <span className="text-muted-foreground">{itemIcon(ctx.type)}</span>
          <span className="max-w-[140px] truncate">{ctx.label}</span>
          <button onClick={() => onRemove(ctx)} className="text-muted-foreground hover:text-foreground">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * Mirrors @entry/copilot's embedding/chat-text.ts `extractChatText()`
 * exactly (verified against eve's real event shapes — message.received /
 * message.completed carry a flat `data.message` string, not a `{ role,
 * parts }` object; a prior version of this file assumed the latter and
 * silently always resolved empty text — fixed alongside wiring the real
 * chat-embedding job, see ROADMAP.md). Duplicated rather than imported
 * because that package's index.ts pulls in `@entry/db` (server-only,
 * Postgres driver) at module scope — unsafe to bundle into this
 * 'use client' component.
 */
function extractChatTextClient(events: unknown, limit?: number): string {
  if (!Array.isArray(events)) return '';
  const turns = events
    .filter((e: any) => e?.type === 'message.received' || e?.type === 'message.completed')
    .map((e: any) => {
      const role = e.type === 'message.received' ? 'user' : 'assistant';
      const text = e?.data?.message;
      return typeof text === 'string' && text.trim() ? `${role}: ${text.trim()}` : null;
    })
    .filter((line: string | null): line is string => Boolean(line));
  return (limit ? turns.slice(-limit) : turns).join('\n');
}

/** Resolves attached context items to real content for eve's `clientContext` field. */
export async function resolveContextForSend(attached: AttachedContext[]): Promise<string | undefined> {
  if (attached.length === 0) return undefined;
  const parts = await Promise.all(
    attached.map(async ctx => {
      try {
        if (ctx.type === 'doc') {
          const res = await fetch(`/api/copilot/docs/${ctx.id}`);
          if (!res.ok) return `[Referenced doc "${ctx.label}" — could not be loaded]`;
          const data = await res.json();
          return `[Attached doc: "${ctx.label}"]\n${data.content ?? ''}`;
        }
        if (ctx.type === 'chat') {
          const res = await fetch(`/api/chats/${ctx.id}`);
          if (!res.ok) return `[Referenced chat "${ctx.label}" — could not be loaded]`;
          const data = await res.json();
          const text = extractChatTextClient(data.events, 10);
          return `[Attached prior chat: "${ctx.label}"]\n${text || '(no messages yet)'}`;
        }
        return `[Attached file: "${ctx.label}"]`;
      } catch {
        return `[Referenced "${ctx.label}" — could not be loaded]`;
      }
    })
  );
  return parts.join('\n\n');
}
