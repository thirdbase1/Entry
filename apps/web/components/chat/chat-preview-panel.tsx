'use client';

/**
 * "Put a browser preview somewhere in the UI, powered by the sandbox of
 * each chat" — the button lives in ChatPageHeader; this is the actual
 * panel it opens.
 *
 * Rebuilt 2026-07-11 (explicit user request: "the preview is having
 * issues, it should always connect... if the preview have issues
 * connecting it should send it automatically to the AI to fix, showing
 * the error -- not when I click preview should it be stating [the
 * error]"): this component used to own its own polling + restart calls,
 * meaning nothing happened at all unless the user had this panel open.
 * Polling, the stuck-detection, the self-heal restart attempt, and the
 * auto-escalation to the agent all now live in `usePreviewAutoFix`
 * (mounted in ChatPageHeader, always running while the chat page is
 * open) -- this component is purely presentational over whatever that
 * hook reports, so a broken preview gets auto-fixed whether or not this
 * panel is ever opened. See that hook's file comment for the full
 * self-heal-then-escalate behavior and ChatPreview's schema comment
 * (packages/db/prisma/schema.prisma) for the two-path (direct vs eve)
 * rationale.
 *
 * ADDED (2026-08-05, explicit user request: "configure the preview to
 * full screen and any type of device screen"): two independent view
 * controls, both preview-tab-only and both purely client-side UI state
 * (no effect on the sandbox/dev-server itself, so they're free to toggle
 * as often as wanted):
 *   - Full screen: blows the panel up from the normal 480px docked
 *     sidebar to the entire viewport. Implemented as a class swap on the
 *     same fixed container, not a separate modal/portal, so every other
 *     prop/effect (iframe key, autofix state, tabs) keeps working
 *     unchanged underneath it.
 *   - Device frame: simulates a real device viewport inside the iframe
 *     area (Desktop = fill available space, Mobile/Tablet = fixed CSS
 *     px dimensions matching a real device, Custom = user-typed W×H) —
 *     the same idea as a browser's own responsive-design device
 *     toolbar. A ResizeObserver measures the surrounding area and scales
 *     the whole device frame down (via CSS transform, never clipped)
 *     whenever the simulated device is larger than the space actually
 *     available, so a Desktop-preset frame still fits inside a docked
 *     480px sidebar instead of just overflowing/scrolling.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2, Monitor, Tablet, Smartphone, Settings2 } from 'lucide-react';
import type { PreviewStatus } from './use-preview-autofix';
import { ChatFilesTab } from './chat-files-tab';
import { ChatVersionsTab } from './chat-versions-tab';
import { ChatBrowserTab } from './chat-browser-tab';

type DevicePresetId = 'desktop' | 'tablet' | 'mobile' | 'custom';

/** Real device CSS-pixel viewport sizes (portrait) -- tablet matches a
 *  standard iPad, mobile matches a standard modern phone (iPhone 14/15
 *  class). `null` size means "fill whatever space is available" (today's
 *  original, only, behavior). */
const DEVICE_PRESETS: { id: DevicePresetId; label: string; icon: typeof Monitor; size: { w: number; h: number } | null }[] = [
  { id: 'desktop', label: 'Desktop', icon: Monitor, size: null },
  { id: 'tablet', label: 'Tablet (768×1024)', icon: Tablet, size: { w: 768, h: 1024 } },
  { id: 'mobile', label: 'Mobile (390×844)', icon: Smartphone, size: { w: 390, h: 844 } },
  { id: 'custom', label: 'Custom', icon: Settings2, size: null },
];

export function ChatPreviewPanel({
  sessionId,
  state,
  autoFixing,
  onManualRestart,
  onRefresh,
  onClose,
  jumpToHistoryNonce,
  jumpToHistoryVersion,
  reconnectedNonce,
}: {
  sessionId: string;
  state: PreviewStatus | null;
  autoFixing: boolean;
  onManualRestart: () => Promise<unknown>;
  onRefresh: () => Promise<void>;
  onClose: () => void;
  /** Bumped by ChatPageHeader (see chat-panel-context.tsx) whenever a
   *  Version card in the chat is tapped -- jumps straight to the History
   *  tab. Optional so every other caller of this panel is unaffected. */
  jumpToHistoryNonce?: number;
  /** The specific version number that triggered `jumpToHistoryNonce`
   *  (2026-07-17, completing a previously half-wired feature: tapping a
   *  Version card already opened the History tab, but always landed on
   *  the top of the list with no indication of which entry the card was
   *  even about -- on a chat with any real history you'd have to
   *  manually scan for it). Forwarded into ChatVersionsTab so it can
   *  actually scroll to and expand that exact entry. */
  jumpToHistoryVersion?: number | null;
  /** Bumped by usePreviewAutoFix every time the preview goes from
   *  unavailable/unknown back to available -- see that hook's comment.
   *  Folded into the iframe's own `key` below so a reconnect (whether
   *  from the self-heal restart, a manual Restart click, or the sandbox
   *  just coming back on its own) always forces a real reload instead of
   *  silently keeping whatever stale frame was already sitting there
   *  under the same unchanged `src` URL. Optional/defaulted so any other
   *  caller of this panel keeps working unchanged. */
  reconnectedNonce?: number;
}) {
  const [restarting, setRestarting] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [tab, setTab] = useState<'preview' | 'files' | 'history' | 'browser'>('preview');
  const [fullScreen, setFullScreen] = useState(false);
  const [device, setDevice] = useState<DevicePresetId>('desktop');
  const [customSize, setCustomSize] = useState({ w: 1024, h: 768 });
  const [devicePickerOpen, setDevicePickerOpen] = useState(false);
  // Tracks "has this preview ever actually loaded" across the whole
  // panel's lifetime, independent of `reloadKey` (which only bumps on a
  // manual Reload click) -- the real signal the Starting/Rebuilding copy
  // below needs.
  const everAvailableRef = useRef(false);
  if (state?.available) everAvailableRef.current = true;

  useEffect(() => {
    if (jumpToHistoryNonce) setTab('history');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpToHistoryNonce]);

  const restart = async () => {
    setRestarting(true);
    try {
      await onManualRestart();
      await onRefresh();
    } finally {
      setRestarting(false);
    }
  };

  const activePreset = DEVICE_PRESETS.find(d => d.id === device) ?? DEVICE_PRESETS[0];
  const deviceSize = device === 'custom' ? customSize : activePreset.size;

  // Scale-to-fit for the simulated device frame (2026-08-05): measures
  // the actual space available around the iframe every time it, the
  // chosen device, or full-screen state changes, and shrinks the WHOLE
  // frame down via a CSS transform so a device bigger than the current
  // panel (e.g. the Desktop/Tablet preset inside a still-docked, non-
  // fullscreen 480px sidebar) is always fully visible, never clipped or
  // silently scroll-only.
  const frameAreaRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    if (!deviceSize) {
      setScale(1);
      return;
    }
    const area = frameAreaRef.current;
    if (!area) return;
    const PADDING = 24;
    const compute = () => {
      const availW = area.clientWidth - PADDING * 2;
      const availH = area.clientHeight - PADDING * 2;
      const next = Math.min(1, availW / deviceSize.w, availH / deviceSize.h);
      setScale(next > 0 ? next : 1);
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(area);
    return () => ro.disconnect();
  }, [deviceSize?.w, deviceSize?.h, fullScreen]);

  return (
    <div
      className={
        fullScreen
          ? 'fixed inset-0 w-full h-full bg-card z-50 flex flex-col shadow-xl'
          : 'fixed inset-y-0 right-0 w-full sm:w-[480px] bg-card border-l border-border z-50 flex flex-col shadow-xl'
      }
    >
      <div className="h-14 border-b border-border px-4 flex items-center justify-between shrink-0 gap-2">
        <div className="flex items-center gap-1 bg-muted rounded-md p-0.5 shrink-0">
          <button
            onClick={() => setTab('preview')}
            className={`text-xs px-2.5 py-1 rounded-sm ${tab === 'preview' ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground'}`}
          >
            Preview
          </button>
          <button
            onClick={() => setTab('files')}
            className={`text-xs px-2.5 py-1 rounded-sm ${tab === 'files' ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground'}`}
          >
            Files
          </button>
          <button
            onClick={() => setTab('history')}
            className={`text-xs px-2.5 py-1 rounded-sm ${tab === 'history' ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground'}`}
            title="Deployment history — revert to any past Vercel deployment"
          >
            History
          </button>
          <button
            onClick={() => setTab('browser')}
            className={`text-xs px-2.5 py-1 rounded-sm ${tab === 'browser' ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground'}`}
            title="Live cloud browser — watch the agent browse in real time"
          >
            Browser
          </button>
        </div>

        {tab === 'preview' && (
          <div className="relative flex items-center gap-1 shrink-0">
            <button
              onClick={() => setDevicePickerOpen(o => !o)}
              className={`h-7 px-2 rounded-md flex items-center gap-1 text-xs hover:bg-accent ${device !== 'desktop' ? 'bg-accent text-foreground' : 'text-muted-foreground'}`}
              title="Simulate a device screen size"
            >
              <activePreset.icon className="w-3.5 h-3.5" />
            </button>
            {devicePickerOpen && (
              <div className="absolute top-9 right-0 bg-popover border border-border rounded-md shadow-lg p-1.5 w-48 z-10">
                {DEVICE_PRESETS.map(preset => (
                  <button
                    key={preset.id}
                    onClick={() => {
                      setDevice(preset.id);
                      if (preset.id !== 'custom') setDevicePickerOpen(false);
                    }}
                    className={`w-full flex items-center gap-2 text-xs px-2 py-1.5 rounded-sm hover:bg-accent ${device === preset.id ? 'bg-accent font-medium' : ''}`}
                  >
                    <preset.icon className="w-3.5 h-3.5 shrink-0" />
                    {preset.label}
                  </button>
                ))}
                {device === 'custom' && (
                  <div className="flex items-center gap-1 px-2 pt-1.5 mt-1 border-t border-border">
                    <input
                      type="number"
                      min={200}
                      value={customSize.w}
                      onChange={e => setCustomSize(s => ({ ...s, w: Math.max(200, Number(e.target.value) || s.w) }))}
                      className="w-16 text-xs px-1.5 py-1 rounded-sm border border-border bg-background"
                    />
                    <span className="text-xs text-muted-foreground">×</span>
                    <input
                      type="number"
                      min={200}
                      value={customSize.h}
                      onChange={e => setCustomSize(s => ({ ...s, h: Math.max(200, Number(e.target.value) || s.h) }))}
                      className="w-16 text-xs px-1.5 py-1 rounded-sm border border-border bg-background"
                    />
                  </div>
                )}
              </div>
            )}
            <button
              onClick={() => setFullScreen(f => !f)}
              className="h-7 w-7 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent"
              title={fullScreen ? 'Exit full screen' : 'Full screen'}
            >
              {fullScreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            </button>
          </div>
        )}

        <div className="flex items-center gap-2 shrink-0 ml-auto">
          {tab === 'preview' && state?.available && (
            <button
              onClick={() => setReloadKey(k => k + 1)}
              className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-accent"
              title="Reload preview"
            >
              Reload
            </button>
          )}
          {tab === 'preview' && (
            <button
              onClick={restart}
              disabled={restarting}
              className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-accent disabled:opacity-50"
            >
              {restarting ? 'Restarting…' : 'Restart'}
            </button>
          )}
          <button onClick={onClose} className="w-7 h-7 rounded-md flex items-center justify-center hover:bg-accent text-muted-foreground">
            ✕
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 relative bg-background">
        {tab === 'files' && <ChatFilesTab sessionId={sessionId} />}
        {tab === 'history' && <ChatVersionsTab sessionId={sessionId} jumpToVersion={jumpToHistoryVersion ?? null} jumpToNonce={jumpToHistoryNonce ?? 0} />}
        {tab === 'browser' && <ChatBrowserTab sessionId={sessionId} />}

        {tab === 'preview' && !state && <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">Checking…</div>}

        {tab === 'preview' && state && state.available && state.url && (
          <div ref={frameAreaRef} className="absolute inset-0 flex items-center justify-center overflow-auto bg-muted/30">
            {deviceSize ? (
              <div
                style={{
                  width: deviceSize.w,
                  height: deviceSize.h,
                  transform: `scale(${scale})`,
                  transformOrigin: 'center center',
                }}
                className="bg-background border border-border rounded-xl shadow-lg overflow-hidden shrink-0"
              >
                <iframe
                  key={`${reloadKey}-${reconnectedNonce ?? 0}`}
                  src={state.url}
                  className="w-full h-full border-0"
                  style={{ width: deviceSize.w, height: deviceSize.h }}
                  title="App preview"
                />
              </div>
            ) : (
              <iframe key={`${reloadKey}-${reconnectedNonce ?? 0}`} src={state.url} className="w-full h-full border-0" title="App preview" />
            )}
          </div>
        )}

        {tab === 'preview' && state && !state.available && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="text-sm text-muted-foreground">
              {state.status === 'error'
                ? state.error || 'Something went wrong starting the preview.'
                // "Rebuilding…" vs "Starting…" (2026-07-17, "improve preview"
                // push) -- these read very differently to a user watching:
                // a preview that's already been up before and just dipped
                // (a tool call restarting the dev server, a self-heal
                // retry) is a normal, reassuring "rebuilding," not the
                // same blank "starting" a genuinely brand-new sandbox
                // shows on its very first boot. reloadKey only ever
                // increments after at least one prior successful load, so
                // it's a reliable signal for "this has been up before."
                : everAvailableRef.current ? 'Rebuilding…' : 'Starting…'}
            </div>
            {autoFixing ? (
              <div className="flex items-center gap-2 text-xs text-amber-600">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse shrink-0" />
                Not connecting — I've already flagged this to the agent to fix. It'll reconnect automatically once fixed.
              </div>
            ) : (
              state.requiresAgentAction && (
                <div className="text-xs text-muted-foreground max-w-xs">Starting up — this will reconnect automatically once it's ready.</div>
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}
