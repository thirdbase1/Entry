/**
 * Model brand icons — now backed by @lobehub/icons (github.com/lobehub/
 * lobe-icons), a maintained 1500+ AI/LLM brand SVG set, instead of the 3
 * hand-drawn icons + letter-monogram fallbacks this used to ship.
 *
 * Deliberately deep-importing each icon from its own module path
 * (`@lobehub/icons/es/<Name>`) instead of the package's top-level export —
 * the top-level barrel also re-exports the `ModelIcon`/`ProviderIcon`/
 * `ProviderCombine` helper components, which pull in `@lobehub/ui` +
 * `antd-style` (a whole separate design-system dependency this app doesn't
 * otherwise use). Deep-importing just the plain brand-icon modules (which
 * genuinely have zero extra dependencies, confirmed: `grep -rl
 * "@lobehub/ui" es/OpenAI es/Claude` etc. — no matches) keeps this
 * one-line-per-family lookup exactly as lightweight as the icons it
 * replaces, which matters given this build is already fighting Vercel's
 * container memory ceiling (see next.config.ts's cpus:1 comment).
 *
 * Which icon a model gets is still resolved purely from the MODEL's own
 * name/id (via lib/model-provider.ts's inferModelFamily), never from the
 * BYOK connection's transport/compatibility mode — a Llama model served
 * over an OpenAI-compatible endpoint still shows the Meta logo, not a
 * generic "OpenAI-compatible" mark.
 */
// Deep-imported all the way down to each icon's own `components/Mono` file
// (the plain, prop-driven currentColor SVG — no variant wrapper) rather
// than the icon's own `index.js`. That folder-level index.js eagerly
// imports ALL of that icon's variants (Mono/Color/Text/Combine/Avatar) at
// module scope, and the `.Avatar` variant specifically needs
// `@lobehub/icons/es/features/IconAvatar`, which pulls in `@lobehub/ui` ->
// `antd-style` -> a peer-dependency on `antd` this app doesn't have
// (confirmed the hard way: importing `@lobehub/icons/es/Grok` alone broke
// the build with "Module not found: Can't resolve 'antd'"). Going one
// level deeper to `components/Mono` sidesteps the variants entirely — that
// file only imports its own brand-color constants, nothing else.
import OpenAIIcon from '@lobehub/icons/es/OpenAI/components/Mono';
import AnthropicIcon from '@lobehub/icons/es/Anthropic/components/Mono';
import GeminiIcon from '@lobehub/icons/es/Gemini/components/Mono';
import MetaIcon from '@lobehub/icons/es/Meta/components/Mono';
import MistralIcon from '@lobehub/icons/es/Mistral/components/Mono';
import DeepSeekIcon from '@lobehub/icons/es/DeepSeek/components/Mono';
import GrokIcon from '@lobehub/icons/es/Grok/components/Mono';
import CohereIcon from '@lobehub/icons/es/Cohere/components/Mono';
import QwenIcon from '@lobehub/icons/es/Qwen/components/Mono';
import PerplexityIcon from '@lobehub/icons/es/Perplexity/components/Mono';
import NovaIcon from '@lobehub/icons/es/Nova/components/Mono';
import ByteDanceIcon from '@lobehub/icons/es/ByteDance/components/Mono';
import MinimaxIcon from '@lobehub/icons/es/Minimax/components/Mono';
import MoonshotIcon from '@lobehub/icons/es/Moonshot/components/Mono';
import NvidiaIcon from '@lobehub/icons/es/Nvidia/components/Mono';
import StepfunIcon from '@lobehub/icons/es/Stepfun/components/Mono';
import ZaiIcon from '@lobehub/icons/es/ZAI/components/Mono';
import ArceeIcon from '@lobehub/icons/es/Arcee/components/Mono';
import InceptionIcon from '@lobehub/icons/es/Inception/components/Mono';
import MorphIcon from '@lobehub/icons/es/Morph/components/Mono';

import type { ModelFamily } from '@/lib/model-provider';

// Re-exported under their old names too, in case anything else in the app
// still imports these directly by name.
export {
  OpenAIIcon as ChatGPTIcon,
  AnthropicIcon as ClaudeIcon,
  GeminiIcon,
  MetaIcon,
  MistralIcon,
  DeepSeekIcon,
  GrokIcon as XAIIcon,
  CohereIcon,
  QwenIcon,
  PerplexityIcon,
};

/** Last-resort fallback for families lobehub has no distinct brand icon for. */
export const GenericModelIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg width="1em" height="1em" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
    <circle cx="10" cy="10" r="8.5" stroke="currentColor" strokeWidth="1.5" opacity="0.5" />
    <path d="M10 13.5v.01M10 6.5a2 2 0 0 1 2 2c0 1.333-2 1.667-2 3.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.5" />
  </svg>
);

const FAMILY_ICON: Record<Exclude<ModelFamily, 'unknown'>, React.FC<React.SVGProps<SVGSVGElement>>> = {
  anthropic: AnthropicIcon,
  openai: OpenAIIcon,
  google: GeminiIcon,
  meta: MetaIcon,
  mistral: MistralIcon,
  deepseek: DeepSeekIcon,
  xai: GrokIcon,
  cohere: CohereIcon,
  qwen: QwenIcon,
  perplexity: PerplexityIcon,
  amazon: NovaIcon,
  bytedance: ByteDanceIcon,
  minimax: MinimaxIcon,
  moonshot: MoonshotIcon,
  nvidia: NvidiaIcon,
  stepfun: StepfunIcon,
  zhipu: ZaiIcon,
  arcee: ArceeIcon,
  inception: InceptionIcon,
  morph: MorphIcon,
};

export function getProviderIcon(provider: string): React.FC<React.SVGProps<SVGSVGElement>> {
  return FAMILY_ICON[provider as Exclude<ModelFamily, 'unknown'>] ?? GenericModelIcon;
}
