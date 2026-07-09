/**
 * Replaces:
 *  - providers/provider.ts   (abstract CopilotProvider base class)
 *  - providers/factory.ts    (CopilotProviderFactory — looped over N provider instances)
 *  - providers/openai.ts, anthropic/*, gemini/*, perplexity.ts, fal.ts, morph.ts, oracle.ts
 *
 * Why one class instead of 8: the original factory's job was "given desired
 * capabilities, find which of N vendor clients can serve it." With the
 * Gateway, there's only ONE client — the vendor is just a prefix on the model
 * id. So `findValidModel` / `selectModel` logic is ported verbatim (same
 * matching semantics), now resolved against the LIVE Gateway catalog
 * (`getModelCatalog()` in models.ts) instead of a hand-maintained static
 * array — per explicit instruction, no hardcoded model ids anywhere in this
 * package. That makes model resolution genuinely async now (a live/cached
 * fetch), so `findValidModel`/`match`/`selectModel` are all `async` — a real,
 * deliberate change from the previous sync version, not an oversight.
 *
 * `checkParams`, prompt-message building, and tool wiring should be ported
 * next the same mechanical way from providers/provider.ts (lines ~154-350) —
 * left as TODO markers below rather than guessed, since they touch the
 * Prisma-backed prompt/session models that haven't been ported into this
 * scaffold yet (Phase 2).
 */
import {
  embedMany,
  generateImage,
  generateObject,
  generateText,
  streamText,
  type ModelMessage,
} from 'ai';
import type { z } from 'zod';

import { gateway } from './gateway';
import { getModelCatalog } from './models';
import { createBrowserAgentTool } from './tools/browser-agent';
import { createChooseTool } from './tools/choose';
import { createCodeArtifactTool } from './tools/code-artifact';
import { createConversationSummaryTool } from './tools/conversation-summary';
import { createDocComposeTool } from './tools/doc-compose';
import { createDocSemanticSearchTool } from './tools/doc-semantic-search';
import { createMakeItRealTool } from './tools/make-it-real';
import { createParallelExtractTool, createParallelSearchTool } from './tools/parallel-search';
import { createPythonCodingTool } from './tools/python-coding';
import { createTaskAnalysisTool } from './tools/task-analysis';
import { createMarkTodoTool, createTodoTool } from './tools/todo';
import { createVercelPythonSandboxTool } from './tools/vercel-sandbox';
import { createBrowserCrawlTool } from './tools/web-crawl';
import {
  ModelInputType,
  ModelOutputType,
  type CopilotProviderModel,
  type ModelCapability,
  type ModelFullConditions,
} from './types';

export interface GatewayToolsConfig {
  parallelApiKey: string;
  /**
   * Stable per-conversation id. When set, python_sandbox and browser_use
   * (and its internal web_crawl_browser fallback) reuse ONE persistent
   * kernel sandbox for the whole chat ("one sandbox per chat") instead of a
   * fresh one per call. Omit to keep the original's stateless-per-call
   * behavior. See vercel-sandbox.ts / browser-agent.ts for why this is an
   * intentional deviation from the original, not a restored capability.
   */
  sessionId?: string;
  /**
   * Authenticated user id — required by doc_compose, make_it_real, and
   * doc_semantic_search for doc persistence and user-scoped vector search.
   */
  userId?: string;
}

/** Which tools to include, mirroring the original's `CopilotChatTools` request-time toggle list. */
export type GatewayToolName =
  | 'browserUse'
  | 'webSearch'
  | 'docCompose'
  | 'taskAnalysis'
  | 'pythonSandbox'
  | 'codeArtifact'
  | 'choose'
  | 'conversationSummary'
  | 'docSemanticSearch'
  | 'makeItReal'
  | 'pythonCoding'
  | 'todoList'
  | 'markTodo';

/**
 * Ported from CopilotProvider#getTools — the switch-case that turned a
 * requested tool-name list into an actual ToolSet. Simplified: no
 * NestJS DI/ModuleRef, no per-request WritableStream for incremental UI
 * streaming yet (Phase 2/3), and 'webSearch' now registers ONE search +
 * crawl pair (Parallel) instead of the original's two redundant vendors
 * (Exa + Cloudsway) — see tools/parallel-search.ts for why.
 */
export function getTools(requested: GatewayToolName[], config: GatewayToolsConfig) {
  const tools: Record<string, unknown> = {};
  for (const name of requested) {
    switch (name) {
      case 'browserUse':
        tools.browser_use = createBrowserAgentTool(config.sessionId);
        break;
      case 'webSearch':
        tools.web_search = createParallelSearchTool({ apiKey: config.parallelApiKey });
        tools.web_crawl = createParallelExtractTool({ apiKey: config.parallelApiKey });
        tools.web_crawl_browser = createBrowserCrawlTool(config.sessionId);
        break;
      case 'docCompose':
        tools.doc_compose = createDocComposeTool({ userId: config.userId, sessionId: config.sessionId });
        break;
      case 'taskAnalysis':
        tools.task_analysis = createTaskAnalysisTool();
        break;
      case 'pythonSandbox':
        tools.python_sandbox = createVercelPythonSandboxTool(config.sessionId);
        break;
      case 'codeArtifact':
        tools.code_artifact = createCodeArtifactTool();
        break;
      case 'choose':
        tools.choose = createChooseTool();
        break;
      case 'conversationSummary':
        tools.conversation_summary = createConversationSummaryTool();
        break;
      case 'docSemanticSearch':
        tools.doc_semantic_search = createDocSemanticSearchTool({ userId: config.userId });
        break;
      case 'makeItReal':
        tools.make_it_real = createMakeItRealTool({ userId: config.userId, sessionId: config.sessionId });
        break;
      case 'pythonCoding':
        tools.python_coding = createPythonCodingTool();
        break;
      case 'todoList':
        tools.todo_list = createTodoTool();
        break;
      case 'markTodo':
        tools.mark_todo = createMarkTodoTool();
        break;
    }
  }
  return tools;
}

export class ModelNotSupportedError extends Error {}

export class GatewayCopilotProvider {
  /**
   * No stored/static model list anymore — `models()` always hits (or
   * transparently reuses the TTL cache from) the live Gateway catalog.
   */
  async models(): Promise<CopilotProviderModel[]> {
    return getModelCatalog();
  }

  /** ported from CopilotProvider#findValidModel, now async against the live catalog */
  private async findValidModel(cond: ModelFullConditions): Promise<CopilotProviderModel | undefined> {
    const { modelId, outputType, inputTypes } = cond;
    const matcher = (cap: ModelCapability) =>
      (!outputType || cap.output.includes(outputType)) &&
      (!inputTypes?.length || inputTypes.every(type => cap.input.includes(type)));

    const catalog = await getModelCatalog();

    if (modelId) {
      const model = catalog.find(m => m.id === modelId && m.capabilities.some(matcher));
      if (model) return model;
      // Gateway can still serve models not (yet) reflected in our cached
      // catalog snapshot (its own catalog stays in sync with each vendor in
      // near-real-time; ours is cached up to CATALOG_TTL_MS) — allow it
      // through uncapped, same "online model" escape hatch the original had
      // per-vendor, and the same reason INPUT-type isn't hard-filterable
      // here (see models.ts's header comment on what the catalog does and
      // doesn't expose).
      return { id: modelId, capabilities: [] };
    }
    if (!outputType) return undefined;

    // No `defaultForOutputType` flag anymore (that was hand-authored on the
    // old static list) — with a live catalog, "default" just means "first
    // capable match in the order the Gateway returns it." Pass an explicit
    // `modelId` when a specific model is actually required.
    return catalog.find(m => m.capabilities.some(matcher));
  }

  async match(cond: ModelFullConditions = {}): Promise<boolean> {
    return !!(await this.findValidModel(cond));
  }

  async selectModel(cond: ModelFullConditions): Promise<CopilotProviderModel> {
    const model = await this.findValidModel(cond);
    if (model) return model;
    const { modelId, outputType, inputTypes } = cond;
    throw new ModelNotSupportedError(
      modelId
        ? `Model ${modelId} does not support ${outputType ?? '<any>'} output with ${inputTypes ?? '<any>'} input`
        : `No model supports ${outputType ?? '<any>'} output with ${inputTypes ?? '<any>'} input`
    );
  }

  async text(cond: ModelFullConditions, messages: ModelMessage[]) {
    const model = await this.selectModel({ ...cond, outputType: ModelOutputType.Text });
    const { text } = await generateText({ model: gateway(model.id), messages });
    return text;
  }

  async streamText(
    cond: ModelFullConditions,
    messages: ModelMessage[],
    options?: { tools?: GatewayToolName[]; toolsConfig?: GatewayToolsConfig }
  ) {
    const model = await this.selectModel({ ...cond, outputType: ModelOutputType.Text });
    const tools =
      options?.tools?.length && options.toolsConfig
        ? getTools(options.tools, options.toolsConfig)
        : undefined;
    return streamText({ model: gateway(model.id), messages, tools: tools as any });
    // TODO Phase 2: reattach TokenTracker (providers/token-tracker.ts) around this call.
  }

  async structured<T>(cond: ModelFullConditions, messages: ModelMessage[], schema: z.ZodType<T>) {
    const model = await this.selectModel({ ...cond, outputType: ModelOutputType.Structured });
    const { object } = await generateObject({ model: gateway(model.id), messages, schema });
    return object as T;
  }

  async embedding(cond: ModelFullConditions, input: string[]) {
    const model = await this.selectModel({ ...cond, outputType: ModelOutputType.Embedding, inputTypes: [ModelInputType.Text] });
    const { embeddings } = await embedMany({ model: gateway.textEmbeddingModel(model.id), values: input });
    return embeddings;
  }

  async image(cond: ModelFullConditions, prompt: string) {
    const model = await this.selectModel({ ...cond, outputType: ModelOutputType.Image });
    const { image } = await generateImage({ model: gateway.imageModel(model.id), prompt });
    return image;
  }
}

export const copilotProvider = new GatewayCopilotProvider();
