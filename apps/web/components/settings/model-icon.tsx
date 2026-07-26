'use client';

/**
 * Small brand-colored glyph badge for a model, keyed off the model id /
 * provider label pattern-matching (owner ask 2026-07-26: "show the model
 * icon"). Deliberately NOT a fetched external logo image — a broken/slow
 * external image would undercut the "very neat" ask far more than a
 * flat colored initial does, and this renders instantly with zero
 * network dependency. Colors are the vendor's real brand accent where
 * one is well-known; falls back to a neutral gray "?" glyph for anything
 * unrecognized rather than guessing wrong.
 */
const FAMILIES: Array<{ test: RegExp; glyph: string; bg: string; fg: string; name: string }> = [
  { test: /gpt|o[1-9]|openai/i, glyph: 'O', bg: '#000000', fg: '#ffffff', name: 'OpenAI' },
  { test: /claude|anthropic/i, glyph: 'C', bg: '#D97757', fg: '#ffffff', name: 'Anthropic' },
  { test: /gemini|google|palm/i, glyph: 'G', bg: '#4285F4', fg: '#ffffff', name: 'Google' },
  { test: /deepseek/i, glyph: 'D', bg: '#4D6BFE', fg: '#ffffff', name: 'DeepSeek' },
  { test: /kimi|moonshot|inkling|thinkingmachines/i, glyph: 'K', bg: '#16A34A', fg: '#ffffff', name: 'Kimi' },
  { test: /minimax/i, glyph: 'M', bg: '#E11D48', fg: '#ffffff', name: 'MiniMax' },
  { test: /qwen/i, glyph: 'Q', bg: '#6D28D9', fg: '#ffffff', name: 'Qwen' },
  { test: /llama|meta/i, glyph: 'L', bg: '#0866FF', fg: '#ffffff', name: 'Llama' },
  { test: /mistral/i, glyph: 'M', bg: '#FA6400', fg: '#ffffff', name: 'Mistral' },
  { test: /grok|xai/i, glyph: 'X', bg: '#1D1D1D', fg: '#ffffff', name: 'xAI' },
  { test: /nemotron|nvidia/i, glyph: 'N', bg: '#76B900', fg: '#ffffff', name: 'NVIDIA' },
  { test: /sensenova|sensetime/i, glyph: 'S', bg: '#0EA5E9', fg: '#ffffff', name: 'SenseNova' },
  { test: /step-|stepfun/i, glyph: 'St', bg: '#7C3AED', fg: '#ffffff', name: 'StepFun' },
  { test: /glm|zhipu/i, glyph: 'Z', bg: '#2563EB', fg: '#ffffff', name: 'GLM' },
];

export function guessModelFamily(modelId: string) {
  return FAMILIES.find(f => f.test.test(modelId)) ?? { glyph: '?', bg: '#6B7280', fg: '#ffffff', name: 'Unknown' };
}

export function ModelIcon({ modelId, size = 20 }: { modelId: string; size?: number }) {
  const family = guessModelFamily(modelId);
  return (
    <span
      title={family.name}
      className="inline-flex items-center justify-center rounded-md font-semibold shrink-0"
      style={{ width: size, height: size, backgroundColor: family.bg, color: family.fg, fontSize: size * 0.5 }}
    >
      {family.glyph}
    </span>
  );
}
