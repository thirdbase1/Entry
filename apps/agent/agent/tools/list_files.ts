import { defineTool } from 'eve/tools';
import { listFilesTool } from '../lib/tool-impls/list_files.js';
export default defineTool(listFilesTool as any);
