import { defineTool } from 'eve/tools';
import { webSearch } from '../lib/tool-impls/web_search.js';
export default defineTool(webSearch);
