import { defineTool } from 'eve/tools';
import { docCompose } from '../lib/tool-impls/doc_compose.js';
export default defineTool(docCompose as any);
