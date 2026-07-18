import { defineTool } from 'eve/tools';
import { rememberAboutUserTool } from '../lib/tool-impls/remember_about_user.js';
export default defineTool(rememberAboutUserTool as any);
