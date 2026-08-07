---
description: "Use when designing or building new UI, or reshaping existing UI, and the goal is a visually distinctive, intentional result rather than a generic AI-templated look. Triggers include requests to design a landing page, dashboard, app UI, or any interface where look-and-feel quality matters, or when a design draft feels bland, templated, or 'like every other AI-generated site'."
metadata: {"author":"entry","version":"1.0.0","inspired_by":"widely-published public commentary on Anthropic's official frontend-design Claude Skill (all-rights-reserved, not reproduced here) and independent UI/UX practice writing"}
---
# Distinctive UI Design

Design like you're the lead at a small studio that's known for giving every client a look nobody else has — not a template with the client's logo swapped in. Treat every visual choice (palette, type, layout, motion) as something you can justify from the actual brief, not a default you reach for automatically.

## Start from the real subject, not a template

Before making any visual choice, pin down: what is this actually for, who is it for, and what's the one job this screen/page has to do. If the brief is vague, make a concrete assumption and say so rather than defaulting to a generic SaaS-landing-page shape. The subject's own world — its materials, its vocabulary, its actual content — is where distinctive choices should come from, not a mood board of "modern web design."

## Recognize (and avoid) the generic-AI-design defaults

There's a small set of looks that AI-generated UI defaults to whenever a brief doesn't pin down a direction:
1. Warm cream/off-white background, high-contrast serif display font, terracotta or muted-orange accent.
2. Near-black background with one bright accent (acid green, vermillion), heavy glow/gradient effects.
3. Dense newspaper/broadsheet layout — hairline rules, square corners, tight multi-column text.

None of these are wrong on their own, but if you land on one of them by default rather than because the brief specifically calls for it, that's a sign you skipped the actual design decision. If the brief does specify a direction, follow it exactly — this list is about not defaulting into a look, not about banning any particular look.

## Work in two passes: plan, then critique, then build

Pass 1 — plan. Before writing any code, sketch a compact design token set:
1. Color: 4-6 named hex values with a one-line reason each ties to the brief.
2. Type: 2 roles minimum — a characterful display face used sparingly, plus a plain, readable body face. Avoid defaulting to the same 2-3 fonts every project reaches for.
3. Layout: describe the structure in a sentence or two, plus a rough ASCII wireframe if it helps compare options.
4. Signature: the one specific element this design will be remembered by.

Pass 2 — critique before building. Look at your own plan and ask: would I produce roughly this same plan for a different, unrelated brief? If yes, that part is generic — revise it and note what changed and why. Only start writing code once the plan feels tied to this specific brief.

## Spend boldness in one place

Pick one signature moment (a hero treatment, an interaction, an unusual layout choice) and make everything else around it disciplined and quiet. A page that's loud everywhere reads as chaotic, not distinctive. Cut any decorative element that doesn't serve the brief — including animation: motion should support one specific moment (page load, a scroll reveal, a hover state), not be scattered everywhere just because it's easy to add.

## Never skip the floor, no matter how bold the direction

Regardless of how experimental the visual direction is:
1. It must work down to mobile widths.
2. Interactive elements need a visible keyboard-focus state.
3. Respect `prefers-reduced-motion` for any animation.
4. Color contrast has to hold up, especially for body text.

## Writing is part of the design, not filler

Copy is design material, same as spacing and color — a generic-sounding UI is often a generic-copy problem, not just a visual one.
1. Name things by what the user does, not by internal system/API terms — "notifications," not "webhook config."
2. Keep button labels and their resulting confirmation/toast text consistent (a "Publish" button should produce a "Published" message, not "Submitted successfully").
3. Error and empty states should say exactly what happened and what to do next — no vague "Something went wrong," no apologizing.

## Self-check before calling it done

Take a screenshot (or otherwise actually look at the rendered result, not just the code) and ask: does this look like it was made for this specific brief, or would this pass as a template for ten other unrelated projects? If it's the latter, go back to the plan step — don't just tweak colors and call it fixed.
