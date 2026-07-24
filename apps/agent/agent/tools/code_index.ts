import { defineTool } from 'eve/tools';
import { codeIndex } from '../lib/tool-impls/code_index.js';

/** Root-agent registration for tree-sitter-backed structural file outlines -- see lib/tool-impls/code_index.ts. */
export default defineTool(codeIndex as any);
