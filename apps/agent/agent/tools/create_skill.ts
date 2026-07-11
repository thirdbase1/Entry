import { defineTool } from 'eve/tools';
import { createSkillTool } from '../lib/tool-impls/create_skill.js';
export default defineTool(createSkillTool as any);
