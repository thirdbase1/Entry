/**
 * One-off admin diagnostic (2026-07-15): reproduces a direct-chat turn's
 * EXACT real tool set against a resolved BYOK model, bypassing the
 * stream/UI layer entirely, and returns the FULL raw provider error
 * (AI_APICallError carries `responseBody` + `requestBodyValues` -- the
 * actual wire-level request/response -- which route.ts's own error
 * logging doesn't capture verbatim). Built specifically to root-cause a
 * live "'str' object has no attribute 'items'" 400 from a self-hosted
 * vLLM-style OpenAI-compatible endpoint without guessing.
 *
 * POST { byokModelId } -- admin/bearer only, see admin/errors/route.ts
 * for the same auth pattern.
 */
import { generateText, generateObject, NoObjectGeneratedError, tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { prisma } from '@entry/db';
import { getUserSessionFromRequest } from '@entry/auth';
import { withApiErrorHandling } from '@/lib/api-error';
import { resolveByokModel } from '@/lib/byok/resolve-model';
import { prisma as prismaDb, decryptApiKey } from '@entry/db';
import { applyToolCacheBreakpoint } from '@/lib/direct-chat/prompt-cache';
import { choose } from '@entry/agent/tool-impls/choose';
import { webCrawl } from '@entry/agent/tool-impls/web_crawl';
import { webSearch } from '@entry/agent/tool-impls/web_search';
import { taskAnalysis } from '@entry/agent/tool-impls/task_analysis';
import { codeArtifact } from '@entry/agent/tool-impls/code_artifact';
import { pythonCoding } from '@entry/agent/tool-impls/python_coding';
import { writeFileTool } from '@entry/agent/tool-impls/write_file';
import { editFileTool } from '@entry/agent/tool-impls/edit_file';
import { bash } from '@entry/agent/tool-impls/bash';
import { browserUse } from '@entry/agent/tool-impls/browser_use';
import { listFilesTool } from '@entry/agent/tool-impls/list_files';
import { saveCredentialTool } from '@entry/agent/tool-impls/save_credential';
import { listCredentialsTool } from '@entry/agent/tool-impls/list_credentials';
import { injectCredentialTool } from '@entry/agent/tool-impls/inject_credential';
import { createSkillTool } from '@entry/agent/tool-impls/create_skill';
import { listSkillsTool } from '@entry/agent/tool-impls/list_skills';
import { recallSkillTool } from '@entry/agent/tool-impls/recall_skill';
import { getPreviewUrlTool } from '@entry/agent/tool-impls/get_preview_url';
import { restartSandboxTool } from '@entry/agent/tool-impls/restart_sandbox';
import { agentDelegate } from '@entry/agent/tool-impls/agent';

function noExec() {
  return async () => ({ ok: true, note: 'diagnostic stub -- never actually runs' });
}

export const GET = withApiErrorHandling(async (req: Request) => {
  const authHeader = req.headers.get('authorization') || '';
  const bearerOk = Boolean(process.env.ADMIN_DEBUG_TOKEN) && authHeader === `Bearer ${process.env.ADMIN_DEBUG_TOKEN}`;
  if (!bearerOk) {
    const { session } = await getUserSessionFromRequest(req);
    if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const url = new URL(req.url);
  const userId = url.searchParams.get('userId');
  const models = await prisma.userModelProviderModel.findMany({
    where: userId ? { provider: { userId } } : undefined,
    include: { provider: true },
    take: 50,
  });
  return Response.json({
    models: models.map(m => ({ id: m.id, modelId: m.modelId, providerLabel: m.provider.label, userId: m.provider.userId, isEnabled: m.isEnabled })),
  });
});

export const POST = withApiErrorHandling(async (req: Request) => {
  const authHeader = req.headers.get('authorization') || '';
  const bearerOk = Boolean(process.env.ADMIN_DEBUG_TOKEN) && authHeader === `Bearer ${process.env.ADMIN_DEBUG_TOKEN}`;
  if (!bearerOk) {
    const { session } = await getUserSessionFromRequest(req);
    if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { byokModelId, userId, toolCount } = (await req.json()) as { byokModelId?: string; userId?: string; toolCount?: number };
  if (!byokModelId || !userId) return Response.json({ error: 'byokModelId and userId are required' }, { status: 400 });

  const { model, providerLabel, modelId } = await resolveByokModel(byokModelId, userId);

  const allTools = {
    choose: tool({ description: choose.description, inputSchema: choose.inputSchema, execute: noExec() }),
    web_crawl: tool({ description: webCrawl.description, inputSchema: webCrawl.inputSchema, execute: noExec() }),
    web_search: tool({ description: webSearch.description, inputSchema: webSearch.inputSchema, execute: noExec() }),
    task_analysis: tool({ description: taskAnalysis.description, inputSchema: taskAnalysis.inputSchema, execute: noExec() }),
    code_artifact: tool({ description: codeArtifact.description, inputSchema: codeArtifact.inputSchema, execute: noExec() }),
    python_coding: tool({ description: pythonCoding.description, inputSchema: pythonCoding.inputSchema, execute: noExec() }),
    write_file: tool({ description: writeFileTool.description, inputSchema: writeFileTool.inputSchema, execute: noExec() }),
    edit_file: tool({ description: editFileTool.description, inputSchema: editFileTool.inputSchema, execute: noExec() }),
    bash: tool({ description: bash.description, inputSchema: bash.inputSchema, execute: noExec() }),
    browser_use: tool({ description: browserUse.description, inputSchema: browserUse.inputSchema, execute: noExec() }),
    list_files: tool({ description: listFilesTool.description, inputSchema: listFilesTool.inputSchema, execute: noExec() }),
    save_credential: tool({ description: saveCredentialTool.description, inputSchema: saveCredentialTool.inputSchema, execute: noExec() }),
    list_credentials: tool({ description: listCredentialsTool.description, inputSchema: listCredentialsTool.inputSchema, execute: noExec() }),
    inject_credential: tool({ description: injectCredentialTool.description, inputSchema: injectCredentialTool.inputSchema, execute: noExec() }),
    create_skill: tool({ description: createSkillTool.description, inputSchema: createSkillTool.inputSchema, execute: noExec() }),
    list_skills: tool({ description: listSkillsTool.description, inputSchema: listSkillsTool.inputSchema, execute: noExec() }),
    recall_skill: tool({ description: recallSkillTool.description, inputSchema: recallSkillTool.inputSchema, execute: noExec() }),
    get_preview_url: tool({ description: getPreviewUrlTool.description, inputSchema: getPreviewUrlTool.inputSchema, execute: noExec() }),
    restart_sandbox: tool({ description: restartSandboxTool.description, inputSchema: restartSandboxTool.inputSchema, execute: noExec() }),
    agent: tool({ description: agentDelegate.description, inputSchema: agentDelegate.inputSchema, execute: noExec() }),
  } as const;

  const entries = Object.entries(allTools).slice(0, toolCount && toolCount > 0 ? toolCount : Object.entries(allTools).length);
  const toolsSubset = Object.fromEntries(entries) as typeof allTools;

  const attempts: Record<string, unknown> = {};

  // Attempt 1: full real tool set, cache markers included, exactly as route.ts sends it.
  try {
    const res = await generateText({
      model,
      instructions: 'You are a diagnostic test. Call the list_files tool with no arguments, then stop.',
      messages: [{ role: 'user', content: 'call list_files now' }],
      tools: applyToolCacheBreakpoint(toolsSubset),
    });
    attempts.fullToolsWithCache = { ok: true, text: res.text, toolCalls: res.toolCalls?.length ?? 0 };
  } catch (err: any) {
    attempts.fullToolsWithCache = {
      ok: false,
      name: err?.name,
      message: err?.message,
      statusCode: err?.statusCode,
      responseBody: err?.responseBody,
      requestBodyValues: err?.requestBodyValues,
      url: err?.url,
    };
  }

  // Attempt 2: multi-step -- let it actually call several tools in a row so
  // tool-result content round-trips back into `messages` for a later step,
  // exactly like a real agentic turn. This is the scenario the single-shot
  // attempt above can't reach (that one succeeded), and it's what a real
  // production chatId (many tool calls deep) actually looks like.
  try {
    const res = await generateText({
      model,
      instructions:
        'You are a diagnostic test. Call list_files, then call bash with command "echo hi", then call web_search with query "test", each one after the previous result comes back, then stop.',
      messages: [{ role: 'user', content: 'run the diagnostic sequence now' }],
      tools: applyToolCacheBreakpoint(toolsSubset),
      stopWhen: stepCountIs(6),
    });
    attempts.multiStep = {
      ok: true,
      steps: res.steps?.length ?? 0,
      toolCalls: res.toolCalls?.length ?? 0,
      finishReason: res.finishReason,
    };
  } catch (err: any) {
    attempts.multiStep = {
      ok: false,
      name: err?.name,
      message: err?.message,
      statusCode: err?.statusCode,
      responseBody: err?.responseBody,
      requestBodyValues: err?.requestBodyValues,
      url: err?.url,
    };
  }

  // Raw two-request header probe: bypasses the AI SDK entirely, hits the
  // relay's own /chat/completions twice back-to-back (turn 1 = plain, turn
  // 2 = same messages + a synthetic prior tool-call/tool-result, exactly
  // like what the SDK sends on step 2) and dumps EVERY response header
  // from both, looking for a session/routing token (e.g. a per-node
  // affinity cookie or request id) that a real multi-node relay might
  // require the client to echo back on the next call -- if the SDK path
  // never captures/forwards such a header, that would explain a fully
  // deterministic (not flaky) 404 on request #2 every single time.
  try {
    const modelRow = await prismaDb.userModelProviderModel.findFirst({
      where: { id: byokModelId, isEnabled: true, provider: { userId } },
      include: { provider: true },
    });
    if (modelRow) {
      const apiKey = modelRow.provider.encryptedApiKey ? decryptApiKey(modelRow.provider.encryptedApiKey) : undefined;
      const url = `${modelRow.provider.baseUrl.replace(/\/$/, '')}/chat/completions`;
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };

      const body1 = { model: modelRow.modelId, messages: [{ role: 'user', content: 'say hi' }], max_tokens: 16 };
      const res1 = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body1) });
      const headers1: Record<string, string> = {};
      res1.headers.forEach((v, k) => { headers1[k] = v; });
      const text1 = await res1.text();

      const body2 = {
        model: modelRow.modelId,
        messages: [
          { role: 'user', content: 'call list_files' },
          { role: 'assistant', content: '', tool_calls: [{ id: 'call_test123', type: 'function', function: { name: 'list_files', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 'call_test123', content: '{"ok":true}' },
        ],
        max_tokens: 16,
      };
      const res2 = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body2) });
      const headers2: Record<string, string> = {};
      res2.headers.forEach((v, k) => { headers2[k] = v; });
      const text2 = await res2.text();

      attempts.rawHeaderProbe = {
        turn1: { status: res1.status, headers: headers1, bodyPreview: text1.slice(0, 300) },
        turn2: { status: res2.status, headers: headers2, bodyPreview: text2.slice(0, 300) },
      };
    }
  } catch (err: any) {
    attempts.rawHeaderProbe = { error: err?.message };
  }

  // Vision + structured-output probe: reuses the browser_use Steel lane's
  // EXACT schema shape and an EXACT-style prompt, with a real (tiny, 2x2
  // red pixel) test image attached, run straight through the resolved
  // model -- settles definitively whether THIS specific BYOK model/relay
  // can do vision + generateObject's structured output at all, rather
  // than inferring it from the tool-calling probes above (which use text
  // only, no image).
  try {
    const tinyRedPngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCg==';
    const { object } = await generateObject({
      model,
      schema: z.object({
        done: z.boolean(),
        stepDescription: z.string(),
        action: z.enum(['goto', 'click', 'fill', 'press', 'scroll_down', 'scroll_up', 'wait_ms', 'switch_tab']).optional(),
        selector: z.string().optional(),
        value: z.string().optional(),
      }),
      system:
        'You control a real remote web browser one action at a time. You are given the current URL, the visible text of ' +
        'the page, and a screenshot. Decide the SINGLE next action needed to make progress, using a Playwright locator ' +
        'string for selector.',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Task: go to the search box and search for "test". Current URL: https://example.com\nVisible page text: A red square is shown.\n\nA screenshot of the current page state is attached.' },
            { type: 'file', data: tinyRedPngBase64, mediaType: 'image/png' },
          ],
        },
      ],
    });
    attempts.visionObjectGen = { ok: true, object };
  } catch (err: any) {
    attempts.visionObjectGen = {
      ok: false,
      isNoObjectGeneratedError: NoObjectGeneratedError.isInstance(err),
      rawText: NoObjectGeneratedError.isInstance(err) ? err.text : undefined,
      name: err?.name,
      message: err?.message,
      statusCode: err?.statusCode,
      responseBody: err?.responseBody,
    };
  }

  // Text-only structured-output probe (no image at all) -- isolates
  // whether the failure is specifically about image/file content parts,
  // or whether this model/relay can't reliably do generateObject's
  // structured output even in the simplest possible case.
  try {
    const { object } = await generateObject({
      model,
      schema: z.object({
        done: z.boolean(),
        stepDescription: z.string(),
        action: z.enum(['goto', 'click', 'fill', 'press', 'scroll_down', 'scroll_up', 'wait_ms', 'switch_tab']).optional(),
        selector: z.string().optional(),
        value: z.string().optional(),
      }),
      system:
        'You control a real remote web browser one action at a time. You are given the current URL and the visible text ' +
        'of the page. Decide the SINGLE next action needed to make progress, using a Playwright locator string for selector.',
      messages: [
        { role: 'user', content: 'Task: go to the search box and search for "test". Current URL: https://example.com\nVisible page text: A search box is shown labelled "Search".' },
      ],
    });
    attempts.textOnlyObjectGen = { ok: true, object };
  } catch (err: any) {
    attempts.textOnlyObjectGen = {
      ok: false,
      isNoObjectGeneratedError: NoObjectGeneratedError.isInstance(err),
      rawText: NoObjectGeneratedError.isInstance(err) ? err.text : undefined,
      name: err?.name,
      message: err?.message,
      statusCode: err?.statusCode,
      responseBody: err?.responseBody,
    };
  }

  // Plain generateText + manual JSON extraction -- exactly the shape of
  // the new decideStepViaPlainText fallback in browser_use.ts, tested
  // directly against this real model.
  try {
    const { text } = await generateText({
      model,
      system:
        'You control a real remote web browser one action at a time. Respond with ONLY a single raw JSON object (no ' +
        'markdown code fences, no explanation) matching exactly this shape: {"done": boolean, "stepDescription": ' +
        'string, "action": one of "goto"|"click"|"fill"|"press"|"scroll_down"|"scroll_up"|"wait_ms"|"switch_tab", ' +
        '"selector": string, "value": string}.',
      messages: [
        { role: 'user', content: 'Task: go to the search box and search for "test". Current URL: https://example.com\nVisible page text: A search box is shown labelled "Search".' },
      ],
    });
    let parsed: unknown = null;
    const start = text.indexOf('{');
    if (start !== -1) {
      let depth = 0;
      for (let i = start; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') {
          depth--;
          if (depth === 0) {
            try { parsed = JSON.parse(text.slice(start, i + 1)); } catch { /* leave null */ }
            break;
          }
        }
      }
    }
    attempts.plainTextJsonFallback = { ok: parsed !== null, rawText: text, parsed };
  } catch (err: any) {
    attempts.plainTextJsonFallback = { ok: false, name: err?.name, message: err?.message };
  }

  return Response.json({ providerLabel, modelId, toolCount: entries.length, attempts });
});
