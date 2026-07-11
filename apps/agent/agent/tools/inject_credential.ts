import { defineTool } from 'eve/tools';
import { injectCredentialTool } from '../lib/tool-impls/inject_credential.js';
export default defineTool(injectCredentialTool as any);
