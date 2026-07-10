import { defineBashTool } from 'eve/tools';

/**
 * Real shell access into the same persistent sandbox browser_use already
 * runs commands in (see ../sandbox/sandbox.ts — python3 + numpy/pandas/
 * matplotlib + agent-browser preinstalled there). This was missing
 * entirely: lib/persona.ts's <tool-calling-guidelines> already instructs
 * the model to "draft a python script [with python_coding] before
 * executing it with `bash` in the sandbox" — but no `agent/tools/bash.ts`
 * ever existed, so every attempt to call it failed with
 * AI_NoSuchToolError ("Model tried to call unavailable tool 'bash'").
 * eve auto-registers a tool per file here, named after the file's own
 * slug — so this file alone (no other wiring) is what makes `bash` a
 * real, callable tool matching what the prompt already promises.
 */
export default defineBashTool({
  description:
    'Execute a shell command in the persistent sandbox (same one browser_use runs in). ' +
    'Use this to actually run code — e.g. `python3 script.py` after drafting it with ' +
    'python_coding, install packages with pip3/npm, inspect files, run curl, etc. ' +
    'Returns real stdout/stderr/exitCode from actual execution.',
});
