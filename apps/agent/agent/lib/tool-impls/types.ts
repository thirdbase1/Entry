/**
 * Minimal structural type for the eve `ctx` param, enough for tool-impls to
 * type-check without importing eve's full (larger, harder-to-re-export)
 * internal ctx type. Both root's defineTool() (real eve ctx) and
 * run_model.ts's nested calls (the same real eve ctx, closed over from its
 * own execute(input, ctx)) satisfy this structurally.
 */
export interface ToolExecCtx {
  getSandbox(): Promise<{
    id: string;
    // `env` was missing from this hand-written type even though the real
    // underlying session (eve's SandboxSession, confirmed against
    // @ai-sdk/provider-utils's SandboxProcessOptions) has always supported
    // it -- browser_use.ts needs it to pass AGENT_BROWSER_ARGS per call
    // (see runCli()'s 2026-07-15 fix), so widening this to match reality.
    // `signal` added 2026-07-16 (see bash.ts's fix comment): the direct-chat
    // sandbox's `run()` (apps/web/lib/direct-chat/sandbox.ts) now accepts an
    // AbortSignal it forwards straight into E2B's own commands.run({signal}),
    // so a tool-local timeout (withTimeoutSignal) can actually cut off an
    // in-flight command instead of only affecting how long the CALLER waits.
    run(opts: { command: string; env?: Record<string, string>; signal?: AbortSignal }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  }>;
  session: {
    id: string;
    auth: { current?: { principalId?: string } | null };
  };
  /**
   * Set ONLY when the current turn is running under a specific (often
   * BYOK) model rather than the root's own default — see gateway.ts's
   * `model()` override param. When present, every tool-impl that does its
   * own internal sub-generation (task_analysis, code_artifact,
   * python_coding) must use THIS model instead
   * of resolving one from the Gateway catalog, so a BYOK turn never
   * touches Gateway at any depth, not just at the top level.
   */
  byokModel?: import('ai').LanguageModel;
  /**
   * Aborts when the active turn is cancelled (real eve ToolContext always
   * has this; widened here the same way `env` was widened onto
   * getSandbox() above -- see that comment). Sub-generation tool-impls
   * (code_artifact, python_coding, task_analysis) combine this with their
   * own internal timeout via `AbortSignal.any` so a slow/hung upstream
   * model call fails fast and visibly instead of riding along until the
   * outer request's own maxDuration silently kills the whole turn.
   */
  abortSignal?: AbortSignal;
}
