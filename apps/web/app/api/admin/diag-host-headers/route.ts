/** TEMP one-off (2026-07-27): confirm what Host/X-Forwarded-Host Pxxl's edge
 * actually forwards per custom domain, to decide if per-request origin
 * detection is safe to use for OAuth redirect_uri instead of one fixed env var. */
export async function GET(req: Request) {
  const h = req.headers;
  return Response.json({
    host: h.get('host'),
    xForwardedHost: h.get('x-forwarded-host'),
    xForwardedProto: h.get('x-forwarded-proto'),
    url: req.url,
  });
}
