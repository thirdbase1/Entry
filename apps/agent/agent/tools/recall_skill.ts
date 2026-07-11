import { defineTool } from 'eve/tools';
import { recallSkillTool } from '../lib/tool-impls/recall_skill.js';
export default defineTool(recallSkillTool as any);
