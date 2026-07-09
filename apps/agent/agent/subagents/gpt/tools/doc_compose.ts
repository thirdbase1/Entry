/**
 * Re-exports the SAME tool definition object root uses — no duplicated
 * logic. Fixes a real bug: subagents previously had zero tools, so
 * delegating a turn to a different model (Claude/GPT/Gemini) silently
 * stripped every capability (web search, browser, code execution, docs).
 */
export { default } from '../../../tools/doc_compose.js';
