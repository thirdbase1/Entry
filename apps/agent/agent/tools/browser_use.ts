import { defineTool } from 'eve/tools';
import { browserUse } from '../lib/tool-impls/browser_use.js';
export default defineTool(browserUse as any);
