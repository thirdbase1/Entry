import { defineTool } from 'eve/tools';
import { editFileTool } from '../lib/tool-impls/edit_file.js';
export default defineTool(editFileTool as any);
