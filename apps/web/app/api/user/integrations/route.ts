import { NextRequest, NextResponse } from 'next/server';
import { getUserSessionFromRequest } from '@entry/auth';
import { withApiErrorHandling } from '@/lib/api-error';
import { z } from 'zod';
import { saveCredential, listCredentials } from '@entry/agent/lib/credential-vault';

/**
 * Deploy-target integrations (Vercel, GitHub, Supabase, Pxxl, Sendbyte, ...)
 * riding on the SAME encrypted vault the AI's save_credential/inject_credential
 * tools already use (see @entry/agent/lib/credential-vault) — this route is
 * just a UI-friendly front door onto it so a user can paste a token once in
 * Settings instead of dictating it into chat. `service` is freeform on
 * purpose (matches the vault), but the Settings UI only exposes the known
 * ones from KNOWN_SERVICES below; anything the AI itself saves via chat
 * (an arbitrary service name) still shows up here too since it's the same
 * table — this route is not the only writer.
 */


/**
 * GET /api/user/integrations
 * List the current user's saved integration credentials — metadata only
 * (service, label, updatedAt). The actual token value is NEVER returned;
 * once saved it can only be used server-side (inject_credential in chat,
 * or a future deploy backend route), never re-displayed.
 */
export const GET = withApiErrorHandling(async (req: NextRequest) => {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const rows = await listCredentials(session.user.id);
  return NextResponse.json({
    credentials: rows.map(r => ({ service: r.service, label: r.label, updatedAt: r.updatedAt })),
  });
});

const SaveSchema = z.object({
  service: z.string().min(1).max(64),
  label: z.string().min(1).max(64).optional(),
  value: z.string().min(1).max(4000),
});

/**
 * POST /api/user/integrations
 * Save (or overwrite) a token for a service. Encrypted at rest via the
 * same AES-256-GCM vault as chat-saved credentials. Never echoes the
 * value back.
 */
export const POST = withApiErrorHandling(async (req: NextRequest) => {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = SaveSchema.parse(await req.json());
  await saveCredential({ userId: session.user.id, service: body.service, label: body.label, value: body.value });
  return NextResponse.json({ ok: true, service: body.service, label: body.label ?? 'default' });
});
