import { defineTool } from 'eve/tools';
import { browserStop } from '../lib/tool-impls/browser_stop.js';
export default defineTool(browserStop as any);
