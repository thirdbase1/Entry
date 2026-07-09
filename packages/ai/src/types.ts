/**
 * Ported 1:1 from packages/backend/server/src/plugins/copilot/providers/types.ts
 * These types are already provider-agnostic in the original code — no changes
 * needed for the Gateway migration, just re-homed here.
 */

export enum ModelInputType {
  Text = 'text',
  Image = 'image',
  Audio = 'audio',
}

export enum ModelOutputType {
  Text = 'text',
  Object = 'object',
  Embedding = 'embedding',
  Image = 'image',
  Structured = 'structured',
}

export interface ModelCapability {
  input: ModelInputType[];
  output: ModelOutputType[];
  defaultForOutputType?: boolean;
}

export interface CopilotProviderModel {
  /** Gateway-qualified id, e.g. "anthropic/claude-opus-4-20250514" */
  id: string;
  name?: string;
  capabilities: ModelCapability[];
}

export type ModelConditions = {
  inputTypes?: ModelInputType[];
  modelId?: string;
};

export type ModelFullConditions = ModelConditions & {
  outputType?: ModelOutputType;
};
