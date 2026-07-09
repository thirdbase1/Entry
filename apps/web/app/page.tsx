'use client';

/**
 * Landing page — ported from the public site at entry.io.
 *
 * The original repo's `home.tsx` was just a redirect to /chats, and the
 * actual landing page lived as a separate deployment at entry.io (not
 * in the app codebase). This is a faithful recreation of that landing page
 * based on the live site (screenshotted + DOM-scraped via browserbase),
 * integrated into the Next.js app as the root route.
 *
 * Production behavior: anyone not signed in sees THIS landing page at `/`
 * (no more forced onboarding redirect for first-time visitors — that was
 * a leftover from the pre-launch port and meant real visitors never saw
 * the page). Signed-in users go straight to /chats. "Get Started" on the
 * hero routes into the product-tour onboarding flow; "Sign in" in the nav
 * bar is the fast path straight to /sign-in for people who already have
 * an account.
 */
import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/auth';

const features = [
  {
    title: 'Multi-agent collaboration',
    description: 'Improved with Claude for plans, Gemini for deep research, and GPT for rewriting feedback; avoids frequent SOTA model costs.',
  },
  {
    title: 'Stop prompt-chasing. Start decision-making',
    description: 'Spec & context engineering give agents structure to plan, score, and surface options. You stay in control of the final call. Achieve more, struggle less.',
  },
  {
    title: 'Real-time progress tracking',
    description: 'Agentic AI displays all progress live.',
  },
  {
    title: 'LLM-backed second brain',
    description: 'Stores chats and media (meetings, videos, images, knowledge) in a memorized library.',
  },
  {
    title: 'Context gathering',
    description: 'Agents automatically memorize and gather relevant context.',
  },
  {
    title: 'AGI and privacy',
    description: 'Supports AGI development without compromising privacy or creating an intelligence monopoly; advocates for open-source AI to protect data.',
  },
];

function LandingContent({ onGetStarted }: { onGetStarted: () => void }) {
  return (
    <div className="min-h-screen flex flex-col items-center bg-background">
      {/* Floating nav bar */}
      <div className="w-full flex justify-center pt-6 px-4">
        <div className="flex items-center justify-between w-full max-w-2xl rounded-full border bg-card shadow-sm px-5 h-12">
          <div className="flex items-center gap-2">
            <img src="/logo.jpg" alt="Entry" width={20} height={20} />
            <span className="text-sm font-semibold text-foreground">Entry</span>
          </div>
          <Link
            href="/sign-in"
            className="text-sm font-medium text-foreground hover:text-muted-foreground transition-colors flex items-center gap-1"
          >
            Sign in <span className="text-muted-foreground">→</span>
          </Link>
        </div>
      </div>

      {/* Hero */}
      <div className="flex flex-col items-center text-center pt-20 px-4 max-w-3xl">
        <h1 className="text-5xl font-bold text-foreground tracking-tight">
          The Open Source
          <br />
          Agentic AI
        </h1>
        <p className="text-lg text-muted-foreground mt-6 max-w-xl">
          Search, think, and complete general tasks — Entry is a multimodal, agentic AI that combines the power of the best foundation models.
        </p>
        <button
          onClick={onGetStarted}
          className="mt-8 inline-flex items-center gap-2 rounded-full bg-primary text-primary-foreground px-6 h-11 text-sm font-medium hover:bg-primary/90 transition-colors"
        >
          Get Started <span>→</span>
        </button>
      </div>

      {/* App preview mockup */}
      <div className="w-full max-w-4xl mt-16 px-4 pb-8">
        <div className="rounded-xl border bg-card shadow-lg overflow-hidden">
          {/* Window top bar */}
          <div className="h-12 border-b flex items-center justify-between px-4">
            <div className="flex items-center gap-2">
              <img src="/logo.jpg" alt="Entry" width={16} height={16} />
              <span className="text-sm font-medium text-foreground truncate">Dual Task: Build a Study Plan &amp; Locate Financing Docs</span>
            </div>
            <div className="flex items-center gap-3">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted-foreground">
                <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted-foreground">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
              </svg>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted-foreground">
                <circle cx="12" cy="12" r="1" />
                <circle cx="19" cy="12" r="1" />
                <circle cx="5" cy="12" r="1" />
              </svg>
              <span className="text-xs font-medium text-foreground border rounded-md px-2 py-1">Share</span>
            </div>
          </div>

          {/* Body: sidebar + main content */}
          <div className="flex h-[280px]">
            {/* Sidebar */}
            <div className="w-48 border-r flex flex-col gap-3 p-3">
              <div className="flex items-center gap-2">
                <div className="size-6 rounded-full bg-muted" />
                <span className="text-xs text-foreground">Emily Kerr</span>
              </div>
              <div className="flex items-center gap-2 rounded-md border bg-muted/50 px-2 h-8">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted-foreground">
                  <circle cx="11" cy="11" r="8" />
                  <path d="M21 21l-4.35-4.35" />
                </svg>
                <span className="text-xs text-muted-foreground">Search</span>
                <span className="text-xs text-muted-foreground ml-auto">⌘K</span>
              </div>
              <div className="flex items-center gap-2 mt-1">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted-foreground">
                  <path d="M12 20h9M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
                </svg>
                <span className="text-xs font-medium text-foreground">Chat</span>
              </div>
            </div>

            {/* Main content */}
            <div className="flex-1 p-4 overflow-hidden">
              <div className="rounded-lg bg-muted px-4 py-3 max-w-md">
                <p className="text-sm text-foreground">Help me create a Japanese study plan</p>
              </div>
              <div className="mt-3 text-sm text-muted-foreground max-w-md">
                Create an effective study plan with Todoist: break tasks into manageable, prioritized, and scheduled steps for...
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Why Entry — features section */}
      <div className="w-full max-w-3xl px-4 py-16">
        <h2 className="text-center text-2xl font-semibold text-foreground mb-10">Why Entry</h2>
        <div className="grid md:grid-cols-2 gap-x-12 gap-y-8">
          {features.map(f => (
            <div key={f.title}>
              <h3 className="text-base font-semibold text-foreground mb-2">{f.title}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">{f.description}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Footer */}
      <div className="w-full border-t py-6 text-center">
        <p className="text-xs text-muted-foreground">© 2025 Entry, All Rights Reserved</p>
      </div>
    </div>
  );
}

export default function Home() {
  const router = useRouter();
  const { user, refreshSession, isLoading } = useAuthStore();

  useEffect(() => {
    refreshSession();
  }, [refreshSession]);

  // Signed-in users skip the marketing page and go straight to the app.
  // Everyone else sees the landing page — no more forced onboarding
  // redirect for first-time visitors.
  useEffect(() => {
    if (!isLoading && user) {
      router.replace('/chats');
    }
  }, [user, isLoading, router]);

  // While we know a session exists and are redirecting, show nothing.
  if (!isLoading && user) {
    return <div className="flex items-center justify-center h-screen text-muted-foreground">Loading...</div>;
  }

  const handleGetStarted = () => router.push('/onboarding');

  return <LandingContent onGetStarted={handleGetStarted} />;
}
