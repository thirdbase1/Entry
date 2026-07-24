import { chromium, type Browser, type Page } from 'playwright-core';

/**
 * ADDED (2026-07-17) -- third parallel browser lane, explicit user
 * request: user integrated Bright Data's "Web Access API / Browser API"
 * (a Puppeteer/Playwright/Selenium-compatible CDP endpoint) and asked
 * for it to be "integrated as another provider."
 *
 * EXPANDED (2026-07-24) -- explicit user request: added a SECOND Bright
 * Data zone ("browser2") as a second, fully independent slot, so two
 * Bright Data sessions can now run at once for the same chat (previously
 * only one). Each zone is its own static CDP credential -- there is no
 * shared state between them, they're just two separate Bright Data
 * "scraping_browser" zones on the same account. `slot` (1 or 2) below
 * picks which zone's `BRIGHTDATA_CDP_URL[_2]` env var to connect to; the
 * tool layer (browser_use.ts) now treats brightdata as a 2-slot provider
 * the exact same way it already treated browser_use's own two slots."
 *
 * Bright Data's Browser API is architecturally DIFFERENT from both
 * existing lanes, not just a third copy of one of them:
 *   - Browser Use Cloud: a REST API that creates/tracks a session by id,
 *     with its own agentic loop.
 *   - Steel: a REST API that creates a session (returns id + a
 *     reconnectable `websocketUrl`), session persists server-side
 *     independent of whether our CDP client is currently attached.
 *   - Bright Data: no create/release REST calls at all. The single
 *     static zone credential IS the "connection string" -- every
 *     `chromium.connectOverCDP(url)` call establishes a session, one
 *     domain per session, 5-minute idle timeout, 60-minute hard cap
 *     (per Bright Data's own docs). There is no documented way to
 *     reattach a LATER connection to an EARLIER one's already-open tabs
 *     -- unlike Steel, closing our client's connection is effectively
 *     the end of that particular browser instance.
 *
 * Consequence (see browser_use.ts's brightdata dispatch branch): this
 * lane is deliberately "one task per session, done in one shot" --
 * no cross-tool-call `session_id` follow-up/continuation is offered for
 * it, unlike the other two lanes. That's an honest reflection of what
 * the provider actually supports, not a missing feature -- claiming
 * continuation here would silently hand back a blank new browser while
 * implying login/cookie state carried over.
 *
 * No live-embed URL is returned by the base API the way Steel's
 * `debugUrl`/Browser Use's `liveUrl` are. Bright Data's real-time viewer
 * is per-PAGE and requires a CDP round-trip (`Page.getFrameTree` +
 * `Page.inspect`, per their FAQ) to obtain a Chrome DevTools inspect URL
 * -- that's what `getLiveInspectUrl` below does, giving the chat UI a
 * genuine real-time view (full DevTools, not just a video) with no
 * extra API calls beyond what's already open.
 */

function cdpUrl(slot: 1 | 2 = 1): string {
  const envVar = slot === 2 ? 'BRIGHTDATA_CDP_URL_2' : 'BRIGHTDATA_CDP_URL';
  const url = process.env[envVar];
  if (!url) throw new Error(`${envVar} is not set -- cannot use Bright Data browser lane (zone ${slot}).`);
  return url;
}

export async function connectBrightDataBrowser(slot: 1 | 2 = 1): Promise<Browser> {
  return chromium.connectOverCDP(cdpUrl(slot));
}

/** Chrome DevTools inspect URL for a specific page -- Bright Data's real-time live-view mechanism (no single embeddable liveUrl exists at the session level like the other two providers have). Returns null if it can't be fetched (never fails the caller over a missing live view). */
export async function getLiveInspectUrl(page: Page): Promise<string | null> {
  try {
    const client = await page.context().newCDPSession(page);
    const { frameTree } = (await client.send('Page.getFrameTree')) as { frameTree: { frame: { id: string } } };
    // 'Page.inspect' is a Bright Data-specific CDP extension (not a
    // standard Chrome DevTools Protocol method), so it isn't in
    // playwright-core's typed command map -- cast the session to accept
    // an arbitrary method/params pair for this one call.
    const untypedClient = client as unknown as { send(method: string, params?: Record<string, unknown>): Promise<{ url: string }> };
    const { url } = await untypedClient.send('Page.inspect', { frameId: frameTree.frame.id });
    return url || null;
  } catch {
    return null;
  }
}
