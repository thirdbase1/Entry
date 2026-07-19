import { defineTool } from 'eve/tools';
import { readFileTool } from '../lib/tool-impls/read_file.js';
export default defineTool(readFileTool as any);
