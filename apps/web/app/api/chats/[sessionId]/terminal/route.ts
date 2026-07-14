/**
 * "Terminal" tab endpoint (2026-07-14, "full coding environment" push --
 * explicit ask for visibility into long-running AI tasks, matching what
 * a real coding platform shows you: not just the end result, but what
 * commands actually ran). Reads straight out of the persisted chat
 * events -- every bash tool call's input/output is already sitting there
 * (both the direct/BYOK path and eve's own path persist their tool calls
 * the same way as an AI-SDK-shaped part, `type: 'tool-bash'`), so this
 * needs no live sandbox handle and works identically on both chat paths,
 * unlike the /files and /preview endpoints which are direct/BYOK-only.
 */
import { getUserSessionFromRequest } from '@entry/auth';
import { getChatSession } from '@entry/copilot';

interface BashEntry {
  id: string;
  command: string;
  output: string;
  exitCode: number | null;
  status: 'running' | 'done' | 'error';
}

function extractBashEntries(events: unknown): BashEntry[] {
  if (!Array.isArray(events)) return [];
  const entries: BashEntry[] = [];
  for (const message of events) {
    const parts = (message as { parts?: unknown[] })?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const p = part as { type?: string; toolCallId?: string; input?: { command?: string }; output?: unknown; state?: string; errorText?: string };
      if (p?.type !== 'tool-bash') continue;
      const output = p.output as { stdout?: string; stderr?: string; exitCode?: number } | string | undefined;
      let outputText = '';
      let exitCode: number | null = null;
      if (typeof output === 'string') {
        outputText = output;
      } else if (output && typeof output === 'object') {
        outputText = [output.stdout, output.stderr].filter(Boolean).join('\n');
        exitCode = typeof output.exitCode === 'number' ? output.exitCode : null;
      }
      const status: BashEntry['status'] = p.errorText ? 'error' : output !== undefined ? 'done' : 'running';
      entries.push({
        id: p.toolCallId || `${entries.length}`,
        command: p.input?.command || '',
        output: p.errorText || outputText,
        exitCode,
        status,
      });
    }
  }
  return entries;
}

export async function GET(req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { sessionId } = await params;
  const chat = await getChatSession(session.user.id, sessionId);
  if (!chat) return Response.json({ error: 'Not found' }, { status: 404 });

  const entries = extractBashEntries((chat as { events?: unknown }).events);
  return Response.json({ entries: entries.slice(-200) });
}
