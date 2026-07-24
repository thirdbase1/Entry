import { defineTool } from 'eve/tools';
import { codeSearch } from '../lib/tool-impls/code_search.js';

/** Root-agent registration for ripgrep-backed code search -- see lib/tool-impls/code_search.ts. */
export default defineTool(codeSearch as any);
