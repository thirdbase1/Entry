/**
 * File-tree endpoint (2026-07-13) — backs the chat header "Files" tab.
 * Same two-path split as /api/chats/[sessionId]/preview (see that
 * route's comment and ChatFileTree's schema comment): direct/BYOK chats
 * have a real external sandbox handle we can query live; the default
 * eve path does not, so it only reads whatever the `list_files` tool
 * last wrote from inside a live agent turn.
 *
 * GET ?content=<relative path> returns that one file's text content
 * instead of the tree — only supported on the direct/BYOK path, since
 * that's the only path with a live sandbox handle outside a tool call.
 */
import { getUserSessionFromRequest } from '@entry/auth';
import { getChatSession } from '@entry/copilot';
import { prisma } from '@entry/db';
import { getSandboxForChat } from '@/lib/direct-chat/sandbox';

const EXCLUDED = ['node_modules', '.git', '.next', 'dist', 'build', '.eve', '.vercel', '.turbo', '__pycache__', '.cache'];
const MAX_CONTENT_BYTES = 200 * 1024;

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function listLive(sandbox: { run(opts: { command: string }): Promise<{ exitCode: number; stdout: string; stderr: string }> }) {
  const pruneExpr = EXCLUDED.map(d => `-name ${shellQuote(d)}`).join(' -o ');
  const cmd = `find . \\( ${pruneExpr} \\) -prune -o -maxdepth 8 -printf '%y|%s|%P\\n' -not -path '.' 2>/dev/null | head -3000`;
  const result = await sandbox.run({ command: cmd });
  return result.stdout
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [type, size, ...rest] = line.split('|');
      const p = rest.join('|');
      return { path: p, type: type === 'd' ? ('dir' as const) : ('file' as const), size: type === 'f' ? Number(size) || 0 : undefined };
    })
    .filter(e => e.path);
}

/**
 * Save an edited file back to the live sandbox (2026-07-14, "full coding
 * environment" push -- the Files tab was read-only until now, a real gap
 * against "VS Code" as the stated bar: seeing code isn't the same as
 * being able to fix a line yourself instead of round-tripping through
 * chat for every small edit). Direct/BYOK only, same reason as `content`
 * reads above -- only that path has a live sandbox handle outside of a
 * tool call. Body: { path: string, content: string }.
 */
export async function PUT(req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { sessionId } = await params;
  const chat = await getChatSession(session.user.id, sessionId);
  if (!chat) return Response.json({ error: 'Not found' }, { status: 404 });

  const isDirect = Boolean(chat.byokModelId || chat.requestedModel);
  if (!isDirect) {
    return Response.json({ error: 'Editing files is only available for direct/BYOK model chats right now.' }, { status: 400 });
  }

  let body: { path?: string; content?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const { path: filePath, content } = body;
  if (typeof filePath !== 'string' || !filePath || filePath.includes('..')) {
    return Response.json({ error: 'Invalid path' }, { status: 400 });
  }
  if (typeof content !== 'string') {
    return Response.json({ error: 'content must be a string' }, { status: 400 });
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
    return Response.json({ error: `File is too large to save (limit ${MAX_CONTENT_BYTES / 1024}KB).` }, { status: 413 });
  }

  try {
    const sandbox = await getSandboxForChat(sessionId);
    // Write via a heredoc rather than echo/printf -- content can contain
    // absolutely anything (quotes, backticks, binary-ish text pasted in)
    // and a heredoc with a randomized, collision-proof delimiter is the
    // one shell-write approach that doesn't need per-character escaping.
    const delimiter = `EOF_${Math.random().toString(36).slice(2)}_${Date.now()}`;
    const dir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';
    const mkdirCmd = dir ? `mkdir -p ${shellQuote(dir)} && ` : '';
    const cmd = `${mkdirCmd}cat > ${shellQuote(filePath)} << '${delimiter}'
${content}
${delimiter}`;
    const result = await sandbox.run({ command: cmd });
    if (result.exitCode !== 0) {
      return Response.json({ error: result.stderr.slice(0, 300) || 'Could not save file' }, { status: 500 });
    }
    return Response.json({ success: true, path: filePath });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function GET(req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { sessionId } = await params;
  const chat = await getChatSession(session.user.id, sessionId);
  if (!chat) return Response.json({ error: 'Not found' }, { status: 404 });

  const isDirect = Boolean(chat.byokModelId || chat.requestedModel);
  const url = new URL(req.url);
  const contentPath = url.searchParams.get('content');

  if (isDirect) {
    try {
      const sandbox = await getSandboxForChat(sessionId);

      if (contentPath) {
        // Reject path traversal outright — this reads real files on a
        // real sandbox from user-controlled input.
        if (contentPath.includes('..')) return Response.json({ error: 'Invalid path' }, { status: 400 });
        const sizeCheck = await sandbox.run({ command: `stat -c%s ${shellQuote(contentPath)} 2>/dev/null || echo -1` });
        const size = Number(sizeCheck.stdout.trim());
        if (size < 0) return Response.json({ error: 'File not found' }, { status: 404 });
        if (size > MAX_CONTENT_BYTES) {
          return Response.json({ error: `File is too large to preview (${Math.round(size / 1024)}KB, limit ${MAX_CONTENT_BYTES / 1024}KB).` }, { status: 413 });
        }
        const read = await sandbox.run({ command: `cat ${shellQuote(contentPath)}` });
        if (read.exitCode !== 0) return Response.json({ error: read.stderr.slice(0, 300) || 'Could not read file' }, { status: 500 });
        return Response.json({ path: contentPath, content: read.stdout });
      }

      const entries = await listLive(sandbox);
      return Response.json({ isDirect: true, entries, updatedAt: new Date().toISOString() });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : String(err), entries: [] }, { status: 200 });
    }
  }

  if (contentPath) {
    return Response.json({ error: 'Viewing individual file content is only available for direct/BYOK model chats right now — ask the agent to show you this file instead.' }, { status: 400 });
  }

  const row = await prisma.chatFileTree.findUnique({ where: { chatId: sessionId } });
  if (!row) {
    return Response.json({
      isDirect: false,
      entries: [],
      requiresAgentAction: true,
      reason: 'No file listing yet. Ask the agent about your project files and it will populate this automatically.',
    });
  }
  return Response.json({ isDirect: false, entries: JSON.parse(row.treeJson), rootLabel: row.rootLabel, updatedAt: row.updatedAt.toISOString() });
}
