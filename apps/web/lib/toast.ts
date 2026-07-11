/**
 * Extracted (2026-07-11) from a one-off helper duplicated inline in
 * library/page.tsx — same exact implementation, just shared now so
 * chat-interface.tsx's model-switch notice (see its own comment) doesn't
 * need a third copy. No new dependency: intentionally not sonner/radix-
 * toast, this app has never had one and a bare DOM node is enough for a
 * fire-and-forget "here's what just happened" notice.
 */
export function toast(msg: string) {
  if (typeof window === 'undefined') return;
  const el = document.createElement('div');
  el.textContent = msg;
  el.className =
    'fixed bottom-6 left-1/2 -translate-x-1/2 bg-card text-card-foreground border rounded-lg px-4 py-2 text-sm shadow-lg z-50 transition-opacity duration-300';
  document.body.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; }, 2000);
  setTimeout(() => el.remove(), 2500);
}
