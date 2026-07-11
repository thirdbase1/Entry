import { defineTool } from 'eve/tools';
import { listCredentialsTool } from '../lib/tool-impls/list_credentials.js';
export default defineTool(listCredentialsTool as any);
