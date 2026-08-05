'use client';

import { useEffect, useRef } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { ChatInterface } from '@/components/chat/chat-interface';
import { useGithubPicker } from '@/store/github-picker';

export default function NewChatPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // One-time seed values only -- captured in a ref on first render so the
  // cleanup effect below can strip them from the URL without racing
  // ChatInterface's own initial read of these same props.
  const seededRef = useRef<{ msg?: string; model?: string } | null>(null);
  if (seededRef.current === null) {
    seededRef.current = {
      msg: searchParams.get('msg') ?? undefined,
      model: searchParams.get('model') ?? undefined,
    };
  }

  // Auto-open the GitHub repo picker when GitHub's update-repo-access
  // redirect sends us back with ?github_picker=1. The callback's
  // setup_action=update handler redirects to /chats?github_picker=1 so
  // the user lands right back in the picker to select their newly-added
  // repo without any extra clicks.
  //
  // FIXED (2026-08-05, real bug: "I click new chat, GitHub repo picker
  // shows, and I didn't click Start with GitHub"). Root cause: this
  // param was opened but NEVER stripped from the URL afterward (unlike
  // msg/model below, which already had this exact one-time-seed
  // staleness problem and were already fixed for it). Once a tab ever
  // landed on /chats?github_picker=1 (via the callback's real redirect),
  // that exact URL stuck around in browser history/back-forward cache
  // forever -- any later reload, back/forward navigation, or mobile tab
  // restore that returned to this same address re-ran this effect and
  // popped the modal again, with the user having done nothing that
  // looked like "click Start with GitHub" THIS time. Folded into the
  // existing seed-stripping effect below (same router.replace call) so
  // it's a one-time consume, exactly like msg/model.
  const openGithubPicker = useGithubPicker(s => s.openPicker);
  const pickerConsumedRef = useRef(false);
  useEffect(() => {
    if (searchParams.get('github_picker') === '1' && !pickerConsumedRef.current) {
      pickerConsumedRef.current = true;
      openGithubPicker();
    }
  }, [searchParams, openGithubPicker]);

  // BUG (2026-07-15, user-reported "I select a model, reload the page, it
  // auto-switches back to [some other model]"): `?model=` here was meant
  // as a one-time deep-link seed (e.g. a "start a new chat with THIS
  // model" link), but `initialModel` in chat-interface.tsx takes priority
  // over the user's actual last-picked model (localStorage) in its
  // useState initializer -- by design, so a genuine deep link isn't
  // silently overridden. The bug: nothing ever REMOVED `?model=` from the
  // URL after it was consumed. Once this exact URL existed once (e.g.
  // pushed by the crossedBucket-redirect effect in chat-interface.tsx,
  // which does `router.push('/chats?' + new URLSearchParams({model}))`),
  // every future reload of that same address-bar URL kept re-seeding the
  // SAME stale model forever -- even after the user picked a different
  // model in the dropdown in between, because picking a model only
  // updates React state + localStorage, never the URL. So a reload always
  // re-won with whatever model happened to be baked into the URL the
  // first time, regardless of the user's latest live pick.
  // Fix: strip `model` (and `msg`, same one-time-seed pattern, same
  // staleness risk) from the URL right after this mount consumes them,
  // via `router.replace` (no new history entry, no visible navigation).
  // A later reload of the now-clean URL falls through to localStorage --
  // the user's actual last choice -- instead of resurrecting a seed value
  // that was only ever supposed to apply once.
  useEffect(() => {
    if (!searchParams.get('msg') && !searchParams.get('model') && !searchParams.get('github_picker') && !searchParams.get('integration_status')) return;
    router.replace(pathname, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex-1 panel h-full">
      <ChatInterface
        placeholder="What can I help you with?"
        placeholderTitle="What can I help you with?"
        className="flex-1"
        initialMessage={seededRef.current.msg}
        initialModel={seededRef.current.model}
      />
    </div>
  );
}
