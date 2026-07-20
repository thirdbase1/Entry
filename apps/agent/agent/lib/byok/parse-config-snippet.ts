/**
 * Parses a pasted provider config snippet (2026-07-18, "improve the whole
 * BYOK adding flow" request) into ready-to-use Add-Provider form fields.
 *
 * Real motivating case: Codex CLI's own `config.toml` format --
 * `model_provider = "aerolink"`, `model = "gpt-5.6-sol"`, a
 * `[model_providers.aerolink]` table with `name`/`base_url`/`wire_api` --
 * is the exact same shape at least half a dozen real aggregators
 * (Fireworks, Portkey, AIHubMix, ZenMux, LangWatch-documented relays, and
 * the one that prompted this: aerolink.lat) hand users to paste into their
 * config file. A user copying that same block into US instead had to
 * manually re-type the label, hunt down which value was the base URL vs.
 * the model id, and figure out that `wire_api = "responses"` means
 * "OpenAI Responses API-compatible" here -- three fields, one paste should
 * cover all of it.
 *
 * Deliberately does NOT try to extract an API key -- these config formats
 * exist specifically so the literal key is never in the file (Codex reads
 * it from `env_key`'s named environment variable instead), and even if a
 * key-looking string were present we should never silently trust an
 * arbitrary pasted blob as a credential; the user still pastes that into
 * its own password field by hand.
 *
 * Handles three real shapes, in this priority order:
 *   1. TOML `[model_providers.<id>]` table (Codex CLI's own format) --
 *      reads `base_url` / `wire_api` / `name` from inside that specific
 *      table (matched against a top-level `model_provider = "<id>"` if
 *      present, else just the first table found), plus a top-level
 *      `model = "..."` for the model id.
 *   2. Bare TOML/`.env`-style `key = "value"` or `key=value` lines with no
 *      table at all (simpler pasted snippets).
 *   3. A JSON object with the same key names.
 * Anything not found is simply omitted -- the caller only overwrites form
 * fields for keys this actually recognized, never blanks one out.
 */
export interface ParsedByokConfig {
  label?: string;
  baseUrl?: string;
  compatibility?: 'OPENAI' | 'OPENAI_RESPONSES';
  modelId?: string;
}

function titleCase(s: string): string {
  return s.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function findKeyValue(block: string, key: string): string | undefined {
  // Matches `key = "value"`, `key="value"`, or `key = value` (bare token,
  // for the rare non-quoted style) -- case-sensitive key, first match only.
  const re = new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*"([^"]*)"`, 'm');
  const quoted = block.match(re);
  if (quoted) return quoted[1];
  const bare = block.match(new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*([^\\s"'#\\n]+)`, 'm'));
  return bare ? bare[1] : undefined;
}

function compatibilityFromWireApi(wireApi: string | undefined): 'OPENAI' | 'OPENAI_RESPONSES' {
  return wireApi?.trim().toLowerCase() === 'responses' ? 'OPENAI_RESPONSES' : 'OPENAI';
}

export function parseByokConfigSnippet(raw: string): ParsedByokConfig {
  const text = raw.trim();
  if (!text) return {};

  // --- Shape 3: JSON object ---------------------------------------------
  if (text.startsWith('{')) {
    try {
      const obj = JSON.parse(text);
      const baseUrl = obj.base_url ?? obj.baseUrl;
      const wireApi = obj.wire_api ?? obj.wireApi;
      const modelId = obj.model ?? obj.modelId ?? obj.model_id;
      const name = obj.name ?? obj.model_provider ?? obj.modelProvider;
      const result: ParsedByokConfig = {};
      if (typeof baseUrl === 'string' && baseUrl) result.baseUrl = baseUrl.trim();
      if (result.baseUrl) result.compatibility = compatibilityFromWireApi(typeof wireApi === 'string' ? wireApi : undefined);
      if (typeof modelId === 'string' && modelId) result.modelId = modelId.trim();
      if (typeof name === 'string' && name) result.label = titleCase(name);
      return result;
    } catch {
      // Fall through to the TOML-style parsing below -- not valid JSON.
    }
  }

  // Top-level `model = "..."` -- Codex's own top-level model selection,
  // distinct from anything inside a `[model_providers.*]` block.
  const topLevelModel = findKeyValue(text, 'model');
  const modelProviderKey = findKeyValue(text, 'model_provider');

  // --- Shape 1: `[model_providers.<id>]` table ---------------------------
  const tableMatches = [...text.matchAll(/\[model_providers\.([^\]]+)\]([\s\S]*?)(?=\n\[|$)/g)];
  if (tableMatches.length > 0) {
    const chosen =
      (modelProviderKey && tableMatches.find(m => m[1].trim() === modelProviderKey.trim())) ?? tableMatches[0];
    const [, providerKey, block] = chosen;
    const baseUrl = findKeyValue(block, 'base_url');
    const wireApi = findKeyValue(block, 'wire_api');
    const name = findKeyValue(block, 'name') ?? providerKey.trim();
    const result: ParsedByokConfig = {};
    if (baseUrl) {
      result.baseUrl = baseUrl.trim();
      result.compatibility = compatibilityFromWireApi(wireApi);
    }
    if (name) result.label = titleCase(name);
    if (topLevelModel) result.modelId = topLevelModel.trim();
    return result;
  }

  // --- Shape 2: bare key = value lines, no table --------------------------
  const baseUrl = findKeyValue(text, 'base_url') ?? findKeyValue(text, 'baseUrl') ?? findKeyValue(text, 'api_base');
  const wireApi = findKeyValue(text, 'wire_api') ?? findKeyValue(text, 'wireApi');
  const name = findKeyValue(text, 'name') ?? modelProviderKey;
  const result: ParsedByokConfig = {};
  if (baseUrl) {
    result.baseUrl = baseUrl.trim();
    result.compatibility = compatibilityFromWireApi(wireApi);
  }
  if (name) result.label = titleCase(name);
  if (topLevelModel) result.modelId = topLevelModel.trim();
  return result;
}
