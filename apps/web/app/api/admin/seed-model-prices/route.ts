/**
 * One-off admin seed: ModelPriceRate rows for every non-HCNSec model
 * actually seen in usage so far (owner ask 2026-07-26: "search for all
 * the model pricing so you can show it"). HCNSec Relay's own models have
 * their own dedicated seed (/api/admin/seed-shared-provider) since those
 * need the "actual serving backend, not the marketing alias" methodology
 * documented there — everything below is a real vendor's own model
 * called under its own real name, priced straight off that vendor's own
 * published pricing page (verified live 2026-07-26, sources noted per
 * row). Idempotent — upserts by (modelPattern, effectiveFrom), safe to
 * POST more than once.
 *
 * NOTE: pricing only applies going forward from effectiveFrom — this
 * does NOT retroactively reprice UsageEvent rows already written before
 * a matching rate existed (same "never retroactively reprice history"
 * rule every rate in this table already follows). Historical calls made
 * before this seed ran will keep showing as unpriced/$0 in the Usage tab.
 */
import { prisma } from '@entry/db';
import { isAdminBearerAuthorized } from '@/lib/admin-auth';

const EFFECTIVE_FROM = new Date('2026-07-26T00:00:00Z');

const RATES: Array<{
  modelPattern: string;
  inputPerMTok: number;
  outputPerMTok: number;
  cacheWritePerMTok?: number;
  cacheReadPerMTok?: number;
  source: string;
}> = [
  // Anthropic — platform.claude.com/docs/en/about-claude/pricing (live 2026-07-26)
  { modelPattern: 'claude-opus-5', inputPerMTok: 5, outputPerMTok: 25, cacheWritePerMTok: 6.25, cacheReadPerMTok: 0.5, source: 'anthropic pricing page' },
  { modelPattern: 'claude-opus-4-6', inputPerMTok: 5, outputPerMTok: 25, cacheWritePerMTok: 6.25, cacheReadPerMTok: 0.5, source: 'anthropic pricing page' },
  // Sonnet 5 intro pricing runs through Aug 31 2026 (today is Jul 26 2026) -- standard $3/$15 takes over after.
  { modelPattern: 'claude-sonnet-5', inputPerMTok: 2, outputPerMTok: 10, cacheWritePerMTok: 2.5, cacheReadPerMTok: 0.2, source: 'anthropic pricing page (intro rate, thru 2026-08-31)' },

  // Google Gemini — ai.google.dev/gemini-api/docs/pricing + gemini-3 guide (live 2026-07-26)
  // cache-read rates not separately published for every SKU -- filled in
  // at Google's own observed ~10% of input ratio, same ratio every SKU
  // that DOES publish one (3.6 Flash, 3.5 Flash, 3.5 Flash-Lite) actually uses.
  { modelPattern: 'gemini-3.1-flash-lite', inputPerMTok: 2, outputPerMTok: 12, cacheReadPerMTok: 0.2, source: 'ai.google.dev gemini-3 guide (<200k tok tier)' },
  { modelPattern: 'gemini-3.6-flash-thinking', inputPerMTok: 1.5, outputPerMTok: 7.5, cacheReadPerMTok: 0.15, source: "ai.google.dev pricing page (thinking tokens billed as output, Google's own doc)" },
  { modelPattern: 'gemini-3.6-flash', inputPerMTok: 1.5, outputPerMTok: 7.5, cacheReadPerMTok: 0.15, source: 'ai.google.dev pricing page' },
  { modelPattern: 'gemini-3.5-flash-lite', inputPerMTok: 0.3, outputPerMTok: 2.5, cacheReadPerMTok: 0.03, source: 'ai.google.dev pricing page' },
  { modelPattern: 'gemini-3.5-flash', inputPerMTok: 1.5, outputPerMTok: 9, cacheReadPerMTok: 0.15, source: 'ai.google.dev pricing page' },
  { modelPattern: 'gemini-2.5-flash', inputPerMTok: 0.3, outputPerMTok: 2.5, cacheReadPerMTok: 0.03, source: 'ai.google.dev pricing page' },

  // OpenAI — developers.openai.com/api/docs/pricing (live 2026-07-26)
  { modelPattern: 'gpt-5.6-sol', inputPerMTok: 5, outputPerMTok: 30, cacheReadPerMTok: 0.5, source: 'openai pricing page' },
  { modelPattern: 'gpt-5.6-luna', inputPerMTok: 1, outputPerMTok: 6, cacheReadPerMTok: 0.1, source: 'openai pricing page' },

  // Explicitly $0 -- the ":free" suffix in this model's own id IS the
  // vendor's own pricing tag (an OpenRouter-style free-tier alias), not
  // an unpriced gap. Genuinely $0/$0, not "we couldn't find a rate".
  { modelPattern: 'poolside/laguna-s-2.1:free', inputPerMTok: 0, outputPerMTok: 0, source: "vendor's own ':free' tier suffix" },
];

export async function POST(req: Request) {
  if (!isAdminBearerAuthorized(req)) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const results: Array<{ modelPattern: string; action: 'created' | 'updated' }> = [];
  for (const r of RATES) {
    const existing = await prisma.modelPriceRate.findFirst({
      where: { modelPattern: r.modelPattern, effectiveFrom: EFFECTIVE_FROM },
    });
    const data = {
      inputPerMTok: r.inputPerMTok,
      outputPerMTok: r.outputPerMTok,
      cacheWritePerMTok: r.cacheWritePerMTok ?? 0,
      cacheReadPerMTok: r.cacheReadPerMTok ?? 0,
    };
    if (existing) {
      await prisma.modelPriceRate.update({ where: { id: existing.id }, data });
      results.push({ modelPattern: r.modelPattern, action: 'updated' });
    } else {
      await prisma.modelPriceRate.create({ data: { modelPattern: r.modelPattern, effectiveFrom: EFFECTIVE_FROM, ...data } });
      results.push({ modelPattern: r.modelPattern, action: 'created' });
    }
  }

  return Response.json({ ok: true, count: results.length, results });
}
