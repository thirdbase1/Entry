import { defineTool } from 'eve/tools';
import { codeDiagnostics } from '../lib/tool-impls/code_diagnostics.js';

/** Root-agent registration for tsc/pyright/cargo-check diagnostics -- see lib/tool-impls/code_diagnostics.ts. */
export default defineTool(codeDiagnostics as any);
