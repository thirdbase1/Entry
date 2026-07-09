import { defineDynamic, defineInstructions } from 'eve/instructions';

/**
 * Dynamic instructions resolver — injects runtime context (current date,
 * timezone, language preference) into the per-session system prompt.
 *
 * Ported from the original's `chat-prompt.ts` `preDefinedParams()` which
 * injected `{{oa::date}}`, `{{oa::language}}`, and `{{oa::timezone}}` via
 * Mustache templating at request time.
 *
 * eve's equivalent is this `defineDynamic` in `agent/instructions/` which
 * resolves per-session at the `session.started` event. The static
 * `instructions.md` remains the always-on core persona; this file adds
 * the dynamic bits on top.
 *
 * The channel (eve.ts) passes `auth.current.attributes` from the JWT,
 * which includes `timezone` and `language` if the client provided them.
 */
export default defineDynamic({
  events: {
    'session.started': (_event, ctx) => {
      const attrs = ctx.session.auth?.current?.attributes ?? {};
      const timezone = (attrs.timezone as string) || 'no preference';
      const language = (attrs.language as string) || 'same language as the user query';
      const currentDate = new Date().toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });

      return defineInstructions({
        markdown: [
          `Current Date: ${currentDate}`,
          `User's timezone is ${timezone}.`,
          `Language preference: ${language}.`,
        ].join('\n'),
      });
    },
  },
});
