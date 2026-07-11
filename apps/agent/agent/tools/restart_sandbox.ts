import { defineTool } from 'eve/tools';
import { restartSandboxTool } from '../lib/tool-impls/restart_sandbox.js';
export default defineTool(restartSandboxTool as any);
