'use client';

/**
 * Landing page — pixel-accurate 1:1 port of the real public marketing site
 * at https://open-agent.io/ (a separate deployment from the app codebase;
 * the app monorepo's own home.tsx is just a redirect, but the actual public
 * marketing site does exist and has real, verifiable structure/CSS/assets).
 *
 * Method: fetched the live site's compiled Vue bundle
 * (static/css/index.5b87d0e7.css, static/js/index.f5621d78.js) directly and
 * extracted the exact scoped CSS rules (colors, spacing, font sizes,
 * radii), downloaded the real feature screenshots, app mockup image, logo,
 * and background video assets, and rebuilt the DOM structure to match.
 * Copy is re-branded OpenAgent -> Entry; content/structure/styling is
 * otherwise verbatim.
 *
 * One deliberate deviation, consistent with an explicit standing
 * instruction from the owner ("why is it showing GitHub and wait-list,
 * we're going fully live production" — no waitlist/GitHub gating): the
 * nav button and hero CTA route into our real onboarding/sign-in instead
 * of a GitHub repo link or an email-waitlist capture (the original site's
 * .waitlist-button/.email-input markup exists in its CSS but isn't
 * actually rendered on the live page — confirmed by visiting it directly).
 * Visual style of both buttons (colors, radius, padding, icon) is kept
 * exactly as extracted.
 */
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/auth';
import { useOnboardingStore } from '@/store/onboarding';
import styles from './landing.module.css';

const features = [
  {
    title: 'Multi-agent collaboration',
    description:
      'Improved with Claude for plans, Gemini for deep research, and GPT for rewriting feedback; avoids frequent SOTA model costs.',
    image: '/landing/multi_agent_collaboration.webp',
  },
  {
    title: 'Stop prompt\u2011chasing. Start decision\u2011making',
    description:
      'Spec & context engineering give agents structure to plan, score, and surface options. You stay in control of the final call. Achieve more, struggle less.',
    image: '/landing/decision_making_automation.webp',
  },
  {
    title: 'Real-time progress tracking',
    description: 'Agentic AI displays all progress live.',
    image: '/landing/real_time_progress_tracking.webp',
  },
  {
    title: 'LLM-backed second brain',
    description:
      'Stores chats and media (meetings, videos, images, knowledge) in a memorized library.',
    image: '/landing/llm_backed_second_brain.webp',
  },
  {
    title: 'Context gathering',
    description: 'Agents automatically memorize and gather relevant context.',
    image: '/landing/context_gathering.webp',
  },
  {
    title: 'AGI and privacy',
    description:
      'Supports AGI development without compromising privacy or creating an intelligence monopoly; advocates for open-source AI to protect data.',
    image: '/landing/agi_and_privacy.webp',
  },
];

function ArrowIcon({ color, className }: { color: 'black' | 'white'; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path
        d="M5 12h14M13 6l6 6-6 6"
        stroke={color === 'black' ? '#000' : '#fff'}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function LandingContent({ onGetStarted }: { onGetStarted: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoReady, setVideoReady] = useState(false);

  return (
    <div className={styles.appWrapper}>
      <video
        ref={videoRef}
        className={`${styles.videoBg} ${videoReady ? styles.ready : ''}`}
        src="/landing/bg.webm"
        poster="/landing/bg-poster.webp"
        autoPlay
        muted
        loop
        playsInline
        onCanPlay={() => setVideoReady(true)}
      />

      {/* Toolbar */}
      <div className={styles.toolbar}>
        <div className={styles.toolbarContent}>
          <div className={styles.logo}>
            <img src="/logo.jpg" alt="Entry" className={styles.logoImage} />
            <span className={styles.wordmark}>Entry</span>
          </div>
          <a href="/sign-in" className={styles.navButton}>
            Sign in
            <ArrowIcon color="black" className={styles.navArrow} />
          </a>
        </div>
      </div>

      {/* Hero */}
      <div className={styles.mainContent}>
        <div className={styles.contentContainer}>
          <h1 className={styles.mainTitle}>
            The Open Source
            <br />
            Agentic AI
          </h1>
          <p className={styles.subtitle}>
            {/* Manual break matching the real open-agent.io's exact wrap
                point. Natural CSS reflow alone puts the break in a
                different spot here because "Entry" is shorter than
                "Open-agent" (fewer characters at the same container
                width) — forcing the same break point guarantees the
                same two-line shape on desktop regardless of that word-
                length difference. Hidden below the tablet breakpoint so
                it doesn't fight the mobile subtitle's own reflow/padding
                rules further down this stylesheet. */}
            Search, think, and complete general tasks — Entry is a multimodal, agentic
            <br className={styles.subtitleBreak} />
            {' '}AI that combines the power of the best foundation models.
          </p>
          <button onClick={onGetStarted} className={styles.ctaButton}>
            Get Started
            <ArrowIcon color="white" className={styles.ctaArrow} />
          </button>
        </div>

        <div className={styles.productImageContainer}>
          <div className={styles.productImageWrapper}>
            <img src="/landing/app-image.webp" alt="Entry app preview" className={styles.productImage} />
          </div>
        </div>
      </div>

      {/* Why Entry */}
      <div className={styles.whySection}>
        <div className={styles.whyContent}>
          <h2 className={styles.whyTitle}>Why Entry</h2>
          <div className={styles.featuresGrid}>
            {features.map(f => (
              <div key={f.title} className={styles.featureCard}>
                <div className={styles.featureText}>
                  <h3 className={styles.featureTitle}>{f.title}</h3>
                  <p className={styles.featureDescription}>{f.description}</p>
                </div>
                <img src={f.image} alt={f.title} className={styles.featureImage} />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className={styles.footer}>
        <div className={styles.footerContent}>
          <img src="/logo.jpg" alt="Entry" className={styles.footerLogoImage} />
          <div className={styles.footerSocial}>
            <a
              href="https://github.com/thirdbase1/Entry"
              target="_blank"
              rel="noreferrer"
              className={styles.socialLink}
              aria-label="GitHub"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 0-.29-.01-1.04-.02-2.04-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.21.08 1.84 1.24 1.84 1.24 1.07 1.84 2.81 1.31 3.5 1 .11-.78.42-1.31.76-1.61-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23.96-.27 1.98-.4 3-.4 1.02 0 2.04.13 3 .4 2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.81 5.62-5.48 5.92.43.37.81 1.1.81 2.22 0 1.6-.02 2.89-.02 3.29 0 .32.22.7.83.58C20.56 21.79 24 17.3 24 12c0-6.63-5.37-12-12-12Z" />
              </svg>
            </a>
            <a
              href="https://x.com/entryapp"
              target="_blank"
              rel="noreferrer"
              className={styles.socialLink}
              aria-label="X (Twitter)"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H15.98l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231ZM17.083 19.77h1.833L7.084 4.126H5.117Z" />
              </svg>
            </a>
          </div>
        </div>
        <div className={styles.footerCopyright}>
          <p>© 2025 Entry, All Rights Reserved</p>
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  const router = useRouter();
  const { user, refreshSession, isLoading } = useAuthStore();
  const { visited } = useOnboardingStore();

  useEffect(() => {
    refreshSession().catch(() => {});
  }, [refreshSession]);

  // Signed-in users skip the marketing page and go straight to the app.
  useEffect(() => {
    if (!isLoading && user) {
      router.replace('/chats');
    }
  }, [user, isLoading, router]);

  if (!isLoading && user) {
    return <div className="flex items-center justify-center h-screen text-muted-foreground">Loading...</div>;
  }

  const handleGetStarted = () => {
    if (!visited) {
      router.push('/onboarding');
    } else {
      router.push('/sign-in');
    }
  };

  return <LandingContent onGetStarted={handleGetStarted} />;
}
