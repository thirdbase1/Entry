import { defineTool } from 'eve/tools';
import { codeArtifact } from '../lib/tool-impls/code_artifact.js';
export default defineTool(codeArtifact as any);
