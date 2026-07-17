/**
 * Download a full project snapshot as of one specific version
 * (2026-07-17, "improve history and versioning" push) -- a real gap:
 * you could view/diff individual files from history but never actually
 * grab the whole project as it existed at some earlier point (e.g. "give
 * me the working copy from before that regression"). Deliberately
 * pure-DB, no sandbox involved at all — every ChatVersionFile row is
 * already a complete stored copy of that file's content, so unlike
 * revert (which must write into a live sandbox) this works identically
 * for eve-default chats too, not just direct/BYOK.
 *
 * Hand-rolled minimal USTAR tar writer + gzip rather than pulling in a
 * new dependency (`archiver`/`tar` aren't already used anywhere in this
 * repo) -- tar's format is simple enough that a small, correct, from-
 * scratch writer is genuinely less risk than adding a new package to a
 * production dependency tree for one download button. Handles the >100-
 * char path case properly via USTAR's `prefix` field instead of silently
 * truncating (a real risk in this project's own deeply-nested paths).
 */
import { getUserSessionFromRequest } from '@entry/auth';
import { getChatSession } from '@entry/copilot';
import { prisma } from '@entry/db';
import { getSnapshotFiles } from '@entry/db/chat-versioning';
import { gzipSync } from 'zlib';

function splitUstarName(path: string): { name: string; prefix: string } {
  if (path.length <= 100) return { name: path, prefix: '' };
  // Find the latest '/' such that the remaining basename fits in 100 and
  // the leading part fits in the 155-byte prefix field.
  let splitAt = -1;
  for (let i = 0; i < path.length; i++) {
    if (path[i] === '/' && path.length - i - 1 <= 100 && i <= 155) splitAt = i;
  }
  if (splitAt === -1) return { name: path.slice(-100), prefix: '' }; // best effort, no good split point
  return { prefix: path.slice(0, splitAt), name: path.slice(splitAt + 1) };
}

function tarHeader(path: string, size: number): Buffer {
  const buf = Buffer.alloc(512);
  const { name, prefix } = splitUstarName(path);
  buf.write(name, 0, 100, 'utf8');
  buf.write('0000644\0', 100, 8, 'utf8'); // mode
  buf.write('0000000\0', 108, 8, 'utf8'); // uid
  buf.write('0000000\0', 116, 8, 'utf8'); // gid
  buf.write(size.toString(8).padStart(11, '0') + ' ', 124, 12, 'utf8'); // size (octal)
  buf.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + ' ', 136, 12, 'utf8'); // mtime
  buf.write('        ', 148, 8, 'utf8'); // checksum placeholder (spaces while computing)
  buf.write('0', 156, 1, 'utf8'); // typeflag: regular file
  buf.write('ustar\0', 257, 6, 'utf8');
  buf.write('00', 263, 2, 'utf8'); // ustar version
  buf.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += buf[i];
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');
  return buf;
}

function buildTarGz(files: Array<{ path: string; content: string }>): Buffer {
  const chunks: Buffer[] = [];
  for (const f of files) {
    const contentBuf = Buffer.from(f.content, 'utf8');
    chunks.push(tarHeader(f.path, contentBuf.length), contentBuf);
    const padLen = (512 - (contentBuf.length % 512)) % 512;
    if (padLen) chunks.push(Buffer.alloc(padLen));
  }
  chunks.push(Buffer.alloc(1024)); // two 512-byte zero blocks mark end-of-archive
  return gzipSync(Buffer.concat(chunks));
}

export async function GET(req: Request, { params }: { params: Promise<{ sessionId: string; versionNumber: string }> }) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { sessionId, versionNumber: versionNumberStr } = await params;
  const versionNumber = Number(versionNumberStr);
  if (!Number.isInteger(versionNumber)) return Response.json({ error: 'Invalid version number' }, { status: 400 });

  const chat = await getChatSession(session.user.id, sessionId);
  if (!chat) return Response.json({ error: 'Not found' }, { status: 404 });

  const version = await prisma.chatVersion.findUnique({ where: { chatId_versionNumber: { chatId: sessionId, versionNumber } } });
  if (!version) return Response.json({ error: 'Version not found' }, { status: 404 });

  const files = await getSnapshotFiles(sessionId, versionNumber);
  if (files.length === 0) {
    return Response.json({ error: 'No files tracked in this version to download.' }, { status: 400 });
  }

  const buffer = buildTarGz(files);
  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="version-${versionNumber}-${sessionId.slice(0, 8)}.tar.gz"`,
      'Content-Length': String(buffer.byteLength),
    },
  });
}
