import { defineTool } from 'eve/tools';
import { makeItReal } from '../lib/tool-impls/make_it_real.js';
export default defineTool(makeItReal as any);
