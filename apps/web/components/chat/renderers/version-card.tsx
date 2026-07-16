'use client';

/**
 * The chat-visible "Version card" — appears automatically after every
 * agent turn that changed >=1 file, per the user's explicit spec:
 * "Version #24 · Just now / 12 files changed / +184 -57", deliberately
 * minimal (no file list here — that's what tapping it is for). Rendered
 * for the `data-version-card` part appended server-side by
 * appendVersionCardMessage (packages/db/src/chat-versioning.ts).
 *
 * A revert produces the exact same part shape but with
 * `revertedFromVersionNumber` set, which per the user's spec reads as
 * "Version 7 · Reverted from v1" — same card, different icon/label, so
 * it sits naturally in the same timeline instead of looking like a
 * separate kind of event.
 */
import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { HistoryIcon, UndoIcon } from '@blocksuite/icons/rc';

export interface VersionCardData {
  versionNumber: number;
  summary: string;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  revertedFromVersionNumber: number | null;
  createdAt: string;
}

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function VersionCard({ data, onOpen }: { data: VersionCardData; onOpen: () => void }) {
  const [ago, setAgo] = useState(() => timeAgo(data.createdAt));
  useEffect(() => {
    const id = setInterval(() => setAgo(timeAgo(data.createdAt)), 30_000);
    return () => clearInterval(id);
  }, [data.createdAt]);

  const isRevert = data.revertedFromVersionNumber != null;

  return (
    <motion.button
      type="button"
      onClick={onOpen}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      whileHover={{ y: -1 }}
      whileTap={{ scale: 0.98 }}
      className="group my-1 w-full max-w-[280px] text-left rounded-xl border border-border bg-card/60 hover:bg-accent/60 hover:border-foreground/15 transition-colors px-3.5 py-3 shadow-sm"
    >
      <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
        {isRevert ? (
          <UndoIcon className="size-3.5 text-amber-500 shrink-0" />
        ) : (
          <HistoryIcon className="size-3.5 text-muted-foreground shrink-0" />
        )}
        <span>Version #{data.versionNumber}</span>
        {isRevert && (
          <span className="text-amber-600 dark:text-amber-400">· Reverted from v{data.revertedFromVersionNumber}</span>
        )}
        <span className="text-muted-foreground font-normal">· {ago}</span>
      </div>

      <div className="mt-1.5 text-[11px] text-muted-foreground truncate">{data.summary}</div>

      <div className="mt-2 flex items-center gap-2 text-[11px]">
        <span className="text-muted-foreground">
          {data.filesChanged} file{data.filesChanged === 1 ? '' : 's'} changed
        </span>
        {data.linesAdded > 0 && <span className="font-mono text-emerald-600 dark:text-emerald-400">+{data.linesAdded}</span>}
        {data.linesRemoved > 0 && <span className="font-mono text-red-600 dark:text-red-400">-{data.linesRemoved}</span>}
        <span className="ml-auto text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity">View →</span>
      </div>
    </motion.button>
  );
}
