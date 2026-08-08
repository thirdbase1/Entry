// TEMPORARY DIAGNOSTIC (2026-08-08) -- proves/disproves whether an
// in-process setTimeout race can actually bound a slow outbound fetch's
// wall-clock time on this Vercel Fluid Compute deployment. Delete once
// the "message never gets a response" root cause is confirmed either way.
export const maxDuration = 60;

export async function GET() {
  const t0 = Date.now();
  const log: string[] = [];
  const push = (m: string) => log.push(`${Date.now() - t0}ms: ${m}`);

  push('start');
  const slowFetch = fetch('https://httpbin.org/delay/10', { cache: 'no-store' })
    .then(r => { push(`slow fetch resolved status=${r.status}`); return 'fetch'; })
    .catch(e => { push(`slow fetch rejected: ${e.message}`); return 'fetch-error'; });

  const timeout = new Promise<string>(resolve =>
    setTimeout(() => { push('3s setTimeout fired'); resolve('timeout'); }, 3000),
  );

  const winner = await Promise.race([slowFetch, timeout]);
  push(`race winner: ${winner}`);

  // Also wait for the slow one to finish so we can see its real total time.
  await slowFetch;
  push('done, total elapsed');

  return Response.json({ log, totalMs: Date.now() - t0 });
}
