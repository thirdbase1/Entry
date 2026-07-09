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
}
