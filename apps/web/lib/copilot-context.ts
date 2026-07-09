/**
 * Shared helpers for the copilot "context" (RAG attachment list) API routes.
 * Ported 1:1 from the original's `ContextSession` (context/session.ts) —
 * `AiContext.config` is a JSON blob shaped `{ userId, chats: [], docs: [],
 * files: [] }` (see models/common/copilot.ts's `ContextConfigSchema`); there
 * are no separate DB columns/relations for chat/doc/file attachments, they
 * all live inside this one JSON field. Ownership of a context is NOT a DB
 * column either — it's `config.userId`, checked against the owning
 * `EveChatSession.userId` at creation time.
 */
import { prisma } from '@entry/db';

export const ArtifactEmbedStatus = {
  processing: 'processing',
  finished: 'finished',
  failed: 'failed',
} as const;
export type ArtifactEmbedStatusValue = (typeof ArtifactEmbedStatus)[keyof typeof ArtifactEmbedStatus];

export interface ContextChatOrDoc {
  id: string;
  chunkSize: number;
  status: ArtifactEmbedStatusValue;
  error: string | null;
  createdAt: number;
}

export interface ContextFile {
  id: string;
  chunkSize: number;
  name: string;
  mimeType?: string;
  status: ArtifactEmbedStatusValue;
  error: string | null;
  blobId: string;
  createdAt: number;
}

export interface ContextConfig {
  userId: string;
  chats: ContextChatOrDoc[];
  docs: ContextChatOrDoc[];
  files: ContextFile[];
}

function isContextConfig(value: unknown): value is ContextConfig {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.userId === 'string';
}

export function parseContextConfig(raw: unknown): ContextConfig | null {
  if (!isContextConfig(raw)) return null;
  const v = raw as unknown as Record<string, unknown>;
  return {
    userId: v.userId as string,
    chats: Array.isArray(v.chats) ? (v.chats as ContextChatOrDoc[]) : [],
    docs: Array.isArray(v.docs) ? (v.docs as ContextChatOrDoc[]) : [],
    files: Array.isArray(v.files) ? (v.files as ContextFile[]) : [],
  };
}

/** Loads an AiContext row and returns it with its parsed config, scoped to the requesting user. */
export async function getOwnedContext(contextId: string, userId: string) {
  const row = await prisma.aiContext.findFirst({ where: { id: contextId } });
  if (!row) return null;
  const config = parseContextConfig(row.config);
  if (!config || config.userId !== userId) return null;
  return { row, config };
}

export async function saveContextConfig(contextId: string, config: ContextConfig) {
  await prisma.aiContext.update({ where: { id: contextId }, data: { config: config as any } });
}

export function fulfillFile(file: ContextFile): Required<ContextFile> {
  return { ...file, mimeType: file.mimeType || 'application/octet-stream' };
}
