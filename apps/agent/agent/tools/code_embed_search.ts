import { defineTool } from 'eve/tools';
import { codeEmbedSearch } from '../lib/tool-impls/code_embed_search.js';

/** Root-agent registration for embedding-based semantic code search -- see lib/tool-impls/code_embed_search.ts. */
export default defineTool(codeEmbedSearch as any);
