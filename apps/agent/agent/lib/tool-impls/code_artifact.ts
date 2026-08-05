import { generateText } from 'ai';
import { z } from 'zod';
import { model } from '../gateway.js';
import type { ToolExecCtx } from './types.js';
import { safeExecute } from './safe-execute.js';
import { withTimeoutSignal } from './with-timeout-signal.js';
import { DEFAULT_TOOL_TIMEOUT_MS } from './with-agent-timeout.js';
import { withTransientRetry } from '../transient-provider-error.js';

function stripCodeFence(raw: string): string {
  let stripped = raw.trim();
  if (stripped.startsWith('```')) {
    const firstNewline = stripped.indexOf('\n');
    if (firstNewline !== -1) stripped = stripped.slice(firstNewline + 1);
    if (stripped.endsWith('```')) stripped = stripped.slice(0, -3);
  }
  return stripped;
}

// ADDED 2026-07-19 ("no feedback loop on output quality"): cheap static
// sanity checks on the generated HTML so obviously-broken output is
// FLAGGED to the calling model (which can regenerate or revise via
// `previousHtml`) instead of being handed to the user as if fine. This
// is a lint, not a proof: no headless browser exists in this serverless
// env (playwright-core here only drives REMOTE browsers), so a full
// render check isn't possible in-process — but most real broken
// artifacts are structural (truncation mid-tag, unbalanced script/style,
// empty body, banned external resources), all catchable by string
// checks for free. Exported for apps/agent/evals/harness-checks.mjs.
export function lintArtifactHtml(html: string): string[] {
  const warnings: string[] = [];
  const lower = html.toLowerCase();
  const count = (re: RegExp) => (lower.match(re) ?? []).length;

  // --- Structural checks (original) ---
  const scriptOpens = count(/<script\b[^>]*>/g);
  const scriptCloses = count(/<\/script>/g);
  if (scriptOpens !== scriptCloses) warnings.push(`unbalanced <script> tags (${scriptOpens} open, ${scriptCloses} close) — JS likely cut off or malformed`);
  const styleOpens = count(/<style\b[^>]*>/g);
  const styleCloses = count(/<\/style>/g);
  if (styleOpens !== styleCloses) warnings.push(`unbalanced <style> tags (${styleOpens} open, ${styleCloses} close) — CSS likely cut off`);
  if (lower.includes('<html') && !lower.includes('</html>')) warnings.push('document opens <html> but never closes it — output looks truncated');
  const visible = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, '').trim();
  if (visible.length === 0 && !lower.includes('<canvas') && !lower.includes('<svg')) warnings.push('page has no visible content at all (and no canvas/svg) — likely an empty shell');
  if (/(?:src|href)\s*=\s*["'](?:https?:)?\/\//i.test(html)) warnings.push('references an external http(s) resource — violates the single-file contract, may break offline');
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(html)) warnings.push('contains emoji — the design bar bans emoji in UI (use inline SVG icons or text labels)');

  // --- AI Slop detection (2026-07-27, research-driven) ---
  // Detect the 7 additional slop patterns that the design bar now bans.
  // These are regex-based heuristics — not perfect, but they catch the
  // most common forms of each pattern. Each warning tells the agent
  // what to fix and how, so the self-critique loop can revise via
  // previousHtml.

  // (a) Gradient text: bg-clip:text + text-transparent on headings
  if (/background[^}]*clip[^}]*text/i.test(html) && /text[^}]*transparent/i.test(html))
    warnings.push('gradient text detected (bg-clip:text + text-transparent) — use solid color or font-weight for hierarchy instead');

  // (b) Nested cards: a card element containing another card element
  // Detect: two+ class="card" (or similar) where one is nested inside
  // another — rough heuristic: count card-like class names, if >2 and
  // any appear within a card's HTML block, flag it.
  const cardMatches = lower.match(/class=["'][^"']*card[^"']*["']/g) ?? [];
  if (cardMatches.length >= 3) {
    // Check if any card div contains another card div inside it
    const cardDivRegex = /<div[^>]*class=["'][^"']*card[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi;
    let match;
    while ((match = cardDivRegex.exec(html)) !== null) {
      if (/class=["'][^"']*card[^"']*["']/i.test(match[1])) {
        warnings.push('nested cards detected (a card inside a card) — flatten the hierarchy, use sections or plain divs instead');
        break;
      }
    }
  }

  // (c) Inter monoculture: only Inter/sans-serif, no heading font pairing
  // Detect: font-family contains only Inter or only generic sans, and
  // no separate heading font rule with a serif or different family.
  const fontFamilies = lower.match(/font-family\s*:\s*([^;}]+)/g) ?? [];
  const allInter = fontFamilies.length > 0 && fontFamilies.every(f => /inter|sans-serif|system-ui|-apple-system/i.test(f));
  const hasSerifHeading = /h[1-6]\s*[^}]*font-family\s*:\s*.*(?<!sans-)(?:serif|georgia|times|playfair|merriweather)/i.test(html) ||
    /\.heading|\.display|\.title\s*[^}]*font-family\s*:\s*.*(?<!sans-)(?:serif|georgia|times|playfair|merriweather)/i.test(html);
  if (allInter && !hasSerifHeading && fontFamilies.length >= 1)
    warnings.push('single-font monoculture detected (only Inter/sans for everything) — use a typographic pairing: a display/heading font + a body font');

  // (d) Thick colored side-border tabs: border-left:3-5px solid accent on nav
  if (/border-left\s*:\s*[3-5]px\s+solid/i.test(html) && /nav|tab|menu|sidebar/i.test(lower))
    warnings.push('thick side-border tabs detected (border-left:3-5px solid) — use background tint or underline instead');

  // (e) Bounce/spring easing: cubic-bezier with overshoot (>1 in y values)
  const beziers = html.match(/cubic-bezier\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/gi) ?? [];
  for (const bz of beziers) {
    const nums = bz.match(/[\d.]+/g) ?? [];
    const y1 = parseFloat(nums[1] || '0');
    const y2 = parseFloat(nums[3] || '0');
    if (y1 > 1 || y1 < 0 || y2 > 1 || y2 < 0) {
      warnings.push('bounce/spring easing detected (cubic-bezier with overshoot) — use ease-out or cubic-bezier(0,0,0.2,1) instead');
      break;
    }
  }

  // (f) Dark glow: pure #000 or #000000 background + neon box-shadow
  if (/(?:background|bg)\s*:\s*(?:#000(?:000)?|black)\b/i.test(html) && /box-shadow\s*:\s*[^}]*(?:#[0-9a-f]{3,8}|rgb)/i.test(html))
    warnings.push('dark glow detected (pure #000 bg + colored shadow) — use tinted dark (#0c0a09, #18181b) instead of pure black');

  // (g) Monotonous spacing: same padding value used 5+ times across
  // different element types — rough heuristic: count unique padding
  // values, if >60% are the same, flag.
  const paddings = lower.match(/padding\s*:\s*([^;}]+)/g) ?? [];
  if (paddings.length >= 5) {
    const vals = paddings.map(p => p.replace(/padding\s*:\s*/, '').trim());
    const counts: Record<string, number> = {};
    for (const v of vals) counts[v] = (counts[v] || 0) + 1;
    const maxCount = Math.max(...Object.values(counts));
    if (maxCount / paddings.length > 0.6)
      warnings.push(`monotonous spacing detected (${maxCount}/${paddings.length} elements use the same padding) — vary spacing by hierarchy: larger gaps between sections, smaller within`);
  }

  // (h) Hero eyebrow chip: a pill/badge with "introducing"/"new"/"now
  // available" text directly above an H1
  if (/(?:introducing|now available|new!|launched)\s*<\/\s*(?:span|p|div)/i.test(html) || /<\s*(?:span|p|div)[^>]*>[^<]*(?:introducing|now available|new!)<\/\s*(?:span|p|div)>\s*<\s*h1/i.test(html))
    warnings.push('hero eyebrow chip detected (pill badge above H1 saying "Introducing..." etc.) — remove unless explicitly requested');

  // --- Vercel Web Interface Guidelines (2026-07-27) ---
  if (/transition\s*:\s*all\b/i.test(html))
    warnings.push('transition:all detected — list properties explicitly (Vercel guideline)');
  if (/outline\s*:\s*none/i.test(html) && !/focus-visible|:focus-within|focus\s*:\s*ring|outline-offset/i.test(html))
    warnings.push('outline:none without focus-visible replacement — interactive elements lose focus indicator (Vercel guideline)');
  if (/onpaste\s*=\s*[^}]*preventDefault/i.test(html))
    warnings.push('onPaste with preventDefault — never block paste (Vercel anti-pattern)');
  if (/user-scalable\s*=\s*no|maximum-scale\s*=\s*1\b/i.test(html))
    warnings.push('disabling zoom (user-scalable=no or maximum-scale=1) — accessibility violation (Vercel anti-pattern)');

  return warnings;
}

// BUMPED 75s -> 600s/10min default, model-overridable (2026-07-20,
// "bump the limit of everything up to 10 minutes by default" -- moving
// off Vercel serverless onto the standalone worker removes the outer
// 300s maxDuration this used to leave headroom under). `timeout_seconds`
// on the input below lets the model ask for more/less per call.
const TIMEOUT_MS = DEFAULT_TOOL_TIMEOUT_MS;

export const codeArtifact = {
  description:
    'Generate a single-file HTML snippet (with inline <style> and <script>) that accomplishes the ' +
    'requested functionality. The final HTML should be runnable when saved as an .html file and ' +
    'opened in a browser. Do NOT reference external resources (CSS, JS, images) except through data URIs.',
  inputSchema: z.object({
    title: z.string().describe('The title of the HTML page'),
    userPrompt: z.string().describe('The user description of the code artifact, will be used to generate the code artifact'),
    // ADDED 2026-07-19: iterate-on-previous. Before this the tool was
    // strictly one-shot — any tweak ("make the button green") forced a
    // from-scratch regeneration that usually changed unrelated things.
    previousHtml: z.string().optional().describe('Pass the html from a previous code_artifact result to REVISE it (userPrompt becomes a change request against it) instead of regenerating from scratch. Strongly preferred for any follow-up tweak.'),
    timeout_seconds: z.number().int().positive().optional()
      .describe('Optional override for how long this generation may run, in seconds. Defaults to 600s (10 min) if omitted.'),
  }),
  async execute({ title, userPrompt, previousHtml, timeout_seconds }: { title: string; userPrompt: string; previousHtml?: string; timeout_seconds?: number }, ctx?: ToolExecCtx) {
    const effectiveTimeoutMs = typeof timeout_seconds === 'number' && timeout_seconds > 0 ? timeout_seconds * 1000 : TIMEOUT_MS;
    // UPDATED (2026-07-17, "improve the whole AI process for long term
    // task") — same two fixes as python_coding.ts's identical rewrite:
    // a transient upstream capacity blip used to fail this whole call
    // outright with zero retry, and a response cut off by
    // `maxOutputTokens` (a real risk for a full single-file HTML+CSS+JS
    // document) returned silently as if it were the complete artifact.
    // `withTransientRetry` now wraps a per-attempt fresh timeout window,
    // and `truncated: finishReason === 'length'` surfaces the latter.
    const { text, finishReason } = await withTransientRetry(async () => {
      const t = withTimeoutSignal(ctx?.abortSignal, effectiveTimeoutMs, 'code_artifact');
      try {
        return await generateText({
          model: await model(undefined, ctx?.byokModel),
          abortSignal: t.signal,
          // FIXED (2026-07-16, real bug: "code_artifact tool is so slow /
          // model uses it and stops without any errors") — this was the one
          // sub-generation tool-impl of the three (task_analysis,
          // code_artifact, python_coding) that never got an explicit
          // `maxOutputTokens` ceiling when python_coding got fixed for the
          // identical class of bug on 2026-07-15 (see that file's comment).
          // Unset meant whatever the SDK/provider default happened to be for
          // whichever fast model `model()` resolves to — for a full
          // single-file HTML document (markup + inline CSS + inline JS all
          // in one response) that default is frequently uncapped or very
          // high, so generation could run far longer than a user perceives
          // as reasonable, with zero visible progress the whole time. A
          // real, explicit ceiling bounds worst-case latency; combined with
          // the timeout above, a call that's still too slow now fails fast
          // and visibly instead of silently riding along until the outer
          // request's own maxDuration kills the whole turn.
          maxOutputTokens: 16000,
          // See task_analysis.ts's comment -- top-level `system`, not an
          // embedded `role: 'system'` message, is what actually survives
          // translation into Responses-API-style providers.
          system:
            'Generate a single-file HTML snippet (inline <style> and <script>, no external resources ' +
            'except data URIs) that fulfills the request. Respond with ONLY the HTML, no explanation. ' +
            'Keep it as lean as reasonably possible for the request — avoid unrequested extra features, ' +
            'inline comments, or boilerplate that inflates length without adding real functionality. ' +
            ' ' +
            'DESIGN QUALITY BAR (unless the request specifies otherwise): ' +
            'No generic AI-template look. BANNED patterns: (1) purple/blue gradient heroes, ' +
            '(2) glassmorphism on everything (backdrop-filter:blur on cards), ' +
            '(3) emoji as icons or in headings, ' +
            '(4) gradient text (bg-clip:text + text-transparent on headings), ' +
            '(5) nested cards (card inside card), ' +
            '(6) single-font monoculture (Inter only for everything), ' +
            '(7) thick colored side-border tabs (border-left:3-5px solid on nav), ' +
            '(8) bounce/spring easing (cubic-bezier with y values >1 or <0), ' +
            '(9) dark glow (pure #000 bg + neon box-shadow), ' +
            '(10) monotonous spacing (same padding at every hierarchy level), ' +
            '(11) hero eyebrow chips (pill badge saying "Introducing..." above H1). ' +
            ' ' +
            'REQUIRED: Use a TYPOGRAPHIC PAIRING — two fonts: a display/heading font + a body font. ' +
            'Good pairings: Georgia headings + system-ui body (editorial), Inter 700 headings + Inter 400 body (modern), ' +
            '"SF Mono" headings + system-ui body (technical). Never use a single font for headings and body. ' +
            ' ' +
            'Pick ONE accent color + tinted neutral scale (warm stone or cool slate, not pure gray), ' +
            'ONE typographic pairing, spacing on a 4/8px rhythm (vary by hierarchy — larger between sections, smaller within), ' +
            'real typographic hierarchy (size AND weight contrast, not size alone), ' +
            'body text ~16px / line-height ~1.5 / max measure ~72ch, ' +
            'generous whitespace, visible hover/focus states (ease-out 150-200ms transitions, never bounce), ' +
            'semantic HTML with labeled inputs and WCAG AA contrast (4.5:1 body, 3:1 large text). ' +
            'Use tinted neutrals, not pure #fff/#f5f5f5 grays. When dark, use tinted blacks (#0c0a09 warm, #18181b cool) not #000. ' +
            ' ' +
            'THEME TOKENS — pick the closest matching theme and adjust deliberately: ' +
            'Warm editorial (default): --bg:#fafaf9;--surface:#fff;--text:#1c1917;--muted:#78716c;--accent:#0d9488;--border:#e7e5e4;--radius:8px;--shadow:0 1px 3px rgb(0 0 0/.08). ' +
            'Cool technical: --bg:#f8fafc;--surface:#fff;--text:#0f172a;--muted:#64748b;--accent:#2563eb;--border:#e2e8f0;--radius:6px;--shadow:0 1px 2px rgb(0 0 0/.05). ' +
            'Dark premium: --bg:#0c0a09;--surface:#1c1917;--text:#fafaf9;--muted:#a8a29e;--accent:#14b8a6;--border:#292524;--radius:8px;--shadow:0 1px 3px rgb(0 0 0/.4). ' +
            'High-contrast minimal: --bg:#ffffff;--surface:#fff;--text:#000000;--muted:#525252;--accent:#ea580c;--border:#d4d4d4;--radius:4px;--shadow:0 1px 2px rgb(0 0 0/.06). ' +
            'Soft pastel: --bg:#fdf4ff;--surface:#fff;--text:#3b0764;--muted:#7e22ce;--accent:#9333ea;--border:#f3e8ff;--radius:12px;--shadow:0 2px 8px rgb(147 51 234/.08). ' +
            ' ' +
            'Base CSS: body{font:16px/1.5 system-ui;background:var(--bg);color:var(--text);margin:0}. ' +
            'Cards: surface bg, 1px border, var(--radius), var(--shadow), 16-24px padding — never nest cards. ' +
            'Buttons: accent bg, white text, 8px 16px padding, radius, darken ~10% on hover, ' +
            '2px accent outline-offset on focus-visible, ease-out 150ms transition. ' +
            'Headings: display font, 600/700 weight for H1-H2, 500 for H3-H4, tight line-height, ' +
            'sizes stepping 1.25x. Max content width 72ch, centered, 24px+ side padding. ' +
            'Vary spacing by hierarchy: 24-48px between sections, 16-24px within, 8-12px between related items. ' +
            ' ' +
            'VERCEL WEB INTERFACE GUIDELINES (mandatory — every generated UI must comply): ' +
            'Accessibility: icon-only buttons need aria-label; interactive elements need onKeyDown/onKeyUp handlers; ' +
            'images need alt (or alt="" if decorative); decorative icons need aria-hidden="true"; ' +
            'async updates (toasts, validation) need aria-live="polite"; use semantic HTML (nav, main, header, footer) before ARIA; ' +
            'headings hierarchical h1-h6; scroll-margin-top on heading anchors. ' +
            'Focus: visible focus via focus-visible:ring or equivalent; NEVER outline-none without focus replacement; ' +
            'use :focus-visible over :focus; group focus with :focus-within for compound controls. ' +
            'Forms: inputs need autocomplete and meaningful name; correct type (email/tel/url/number) and inputmode; ' +
            'labels clickable (htmlFor or wrapping); spellCheck={false} on emails/codes/usernames; ' +
            'submit button stays enabled until request starts; errors inline next to fields; placeholders end with ellipsis. ' +
            'Animation: honor prefers-reduced-motion (provide reduced variant or disable); animate transform/opacity only; ' +
            'NEVER transition:all — list properties explicitly; set correct transform-origin; animations interruptible. ' +
            'Typography: use ellipsis character not three dots; curly quotes not straight; non-breaking spaces for units (10 MB, Cmd+K); ' +
            'font-variant-numeric:tabular-nums for number columns; text-wrap:balance on headings. ' +
            'Content: text containers handle long content (truncate/line-clamp/break-words); flex children need min-w:0; ' +
            'handle empty states; anticipate short/average/very long user input. ' +
            'Images: explicit width and height (prevents CLS); loading="lazy" below fold; priority/fetchpriority="high" above fold. ' +
            'Performance: large lists (>50 items) virtualize; no layout reads in render; batch DOM reads/writes; ' +
            'add link rel="preconnect" for CDN domains; critical fonts preloaded with font-display:swap. ' +
            'Navigation: URL reflects state (filters, tabs, pagination in query params); links use a/Link (Cmd+Ctrl+click); ' +
            'destructive actions need confirmation — never immediate. ' +
            'Touch: touch-action:manipulation; overscroll-behavior:contain in modals/drawers; ' +
            'autoFocus sparingly (desktop only, avoid on mobile). ' +
            'Dark mode: color-scheme:dark on html for dark themes; meta name="theme-color" matches page bg. ' +
            'i18n: use Intl.DateTimeFormat and Intl.NumberFormat — never hardcoded formats; ' +
            'wrap brand names and code tokens with translate="no". ' +
            'Copy: active voice; Title Case for headings/buttons; numerals for counts; ' +
            'specific button labels ("Save API Key" not "Continue"); error messages include fix/next step. ' +
            'ANTI-PATTERNS (never generate these): user-scalable=no; onPaste+preventDefault; transition:all; ' +
            'outline-none without focus-visible; div/span with click handlers (should be button); ' +
            'images without dimensions; large arrays .map() without virtualization; form inputs without labels; ' +
            'icon buttons without aria-label; hardcoded date/number formats; autoFocus without justification.',
          messages: [{ role: 'user', content: userPrompt }],
        });
      } catch (err) {
        throw t.rethrow(err);
      } finally {
        t.clear();
      }
    });

    const html = stripCodeFence(text);
    const truncated = finishReason === 'length';
    // Static sanity pass (lintArtifactHtml above). Surfaced as `note` in
    // the tool result — the persona's verify step treats a flagged
    // artifact as a draft to revise (cheap now via previousHtml).
    const lintWarnings = truncated ? [] : lintArtifactHtml(html);
    return {
      title,
      html,
      size: html.length,
      truncated,
      note: truncated
        ? 'Output was cut off by the token limit before finishing — this HTML is likely incomplete/broken. Ask for a leaner version or split it into parts.'
        : lintWarnings.length
          ? `Automatic sanity check flagged possible problems: ${lintWarnings.join('; ')}. Review before presenting — revise via previousHtml if real.`
          : undefined,
    };
  },
};

codeArtifact.execute = safeExecute('code_artifact', codeArtifact.execute) as typeof codeArtifact.execute;
