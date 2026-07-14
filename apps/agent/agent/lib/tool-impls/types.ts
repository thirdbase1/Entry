/**
 * Minimal structural type for the eve `ctx` param, enough for tool-impls to
 * type-check without importing eve's full (larger, harder-to-re-export)
 * internal ctx type. Both root's defineTool() (real eve ctx) and
 * run_model.ts's nested calls (the same real eve ctx, closed over from its
 * own execute(input, ctx)) satisfy this structurally.
 */
export interface ToolExecCtx {
  getSandbox(): Promise<{ id: string; run(opts: { command: string }): Promise<{ exitCode: number; stdout: string; stderr: string }> }>;
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
}
