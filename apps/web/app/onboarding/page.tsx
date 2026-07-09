'use client';

/**
 * Production onboarding flow (rebrand to Entry, full public launch).
 *
 * 5-step flow: Welcome → MultiAgent → TodoList → Showcase → Select. The
 * Select step's single CTA marks onboarding as visited and routes straight
 * to /sign-in.
 *
 * The original (beta-era) version of this page had two more steps that no
 * longer apply now that Entry is a fully live production product:
 *  - A "GitHub Self-deployment" card linking out to the source repo — this
 *    was never a real open-source distribution path for the hosted product.
 *  - A "Register and Join Waiting List" card + Register/Waiting steps that
 *    captured an email for early-access approval before letting people in.
 * Both were removed; there is no waitlist or GitHub link anywhere in this
 * flow anymore.
 */
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { EnterAnim, LeaveAnim } from './anim';
import { OnboardingStep, useOnboardingStore } from '@/store/onboarding';
import { MultiAgentPreview } from './assets/multi-agent-preview';
import { TodoListPreview } from './assets/todo-list-preview';
import { ShowCaseVideo } from './assets/show-case-video';

interface StepProps {
  onNext?: () => void;
  onPrev?: () => void;
}

const Logo = () => (
  <div className="size-[55px] bg-card rounded-full shadow-lg flex items-center justify-center mb-6 border overflow-hidden">
    <img src="/logo.jpg" alt="Entry" width={55} height={55} className="w-full h-full object-cover" />
  </div>
);

const Title = ({ children }: { children: React.ReactNode }) => (
  <h1 className="text-2xl font-semibold text-center mb-2 text-foreground max-w-lg">{children}</h1>
);
const Caption = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <p className={`text-sm text-muted-foreground text-center max-w-md mb-6 ${className ?? ''}`}>{children}</p>
);

const NextButton = ({ children, onClick, className }: { children: React.ReactNode; onClick: () => void; className?: string }) => (
  <button
    onClick={onClick}
    className={`inline-flex items-center justify-center rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 h-10 w-[200px] ${className ?? ''}`}
  >
    {children}
  </button>
);

const BackButton = ({ children, onClick }: { children: React.ReactNode; onClick: () => void }) => (
  <button
    onClick={onClick}
    className="inline-flex items-center justify-center rounded-md text-sm font-medium h-10 w-[200px] text-muted-foreground hover:bg-accent"
  >
    {children}
  </button>
);

function cn(...classes: (string | undefined | false)[]): string {
  return classes.filter(Boolean).join(' ');
}

function StepShell({ show, onAnimationEnd, items }: { show: boolean; onAnimationEnd: () => void; items: React.ReactNode[] }) {
  return (
    <LeaveAnim show={show} onAnimationEnd={onAnimationEnd} className="flex flex-col items-center">
      <EnterAnim items={items} />
    </LeaveAnim>
  );
}

const WelcomeStep: React.FC<StepProps> = ({ onNext }) => {
  const [show, setShow] = useState(true);
  return (
    <StepShell
      show={show}
      onAnimationEnd={() => onNext?.()}
      items={[
        <Logo key="logo" />,
        <Title key="t">Welcome to Entry</Title>,
        <Caption key="c">Chat with all the frontier models and our multi-agent will have the job done</Caption>,
        <NextButton key="b" className="mt-4" onClick={() => setShow(false)}>Get Started</NextButton>,
      ]}
    />
  );
};

const MultiAgentStep: React.FC<StepProps> = ({ onNext, onPrev }) => {
  const [show, setShow] = useState(true);
  const [dir, setDir] = useState<'next' | 'prev'>('next');
  return (
    <StepShell
      show={show}
      onAnimationEnd={() => dir === 'next' ? onNext?.() : onPrev?.()}
      items={[
        <Title key="t">Multi-agent that collaborate together</Title>,
        <Caption key="c">Instead of chatting with singluar AI, all the frontier models collaborate together to finish your task with our multi-agents</Caption>,
        <MultiAgentPreview key="p" />,
        <NextButton key="b" className="mt-8" onClick={() => { setDir('next'); setShow(false); }}>Continue</NextButton>,
      ]}
    />
  );
};

const TodoListStep: React.FC<StepProps> = ({ onNext, onPrev }) => {
  const [show, setShow] = useState(true);
  const [dir, setDir] = useState<'next' | 'prev'>('next');
  return (
    <StepShell
      show={show}
      onAnimationEnd={() => dir === 'next' ? onNext?.() : onPrev?.()}
      items={[
        <Title key="t">Stop prompt‑chasing. Start decision‑making</Title>,
        <Caption key="c">Spec & context engineering give agents structure to plan, score, and surface options. You stay in control of the final call. Achieve more, struggle less.</Caption>,
        <TodoListPreview key="p" />,
        <NextButton key="b" className="mt-8" onClick={() => { setDir('next'); setShow(false); }}>Continue</NextButton>,
      ]}
    />
  );
};

const ShowcaseStep: React.FC<StepProps> = ({ onNext, onPrev }) => {
  const [show, setShow] = useState(true);
  const [dir, setDir] = useState<'next' | 'prev'>('next');
  return (
    <StepShell
      show={show}
      onAnimationEnd={() => dir === 'next' ? onNext?.() : onPrev?.()}
      items={[
        <Title key="t">See what Entry can do for you</Title>,
        <Caption key="c" className="mb-4">Spec & context engineering give agents structure to plan, score, and surface options. You stay in control of the final call. Achieve more, struggle less.</Caption>,
        <ShowCaseVideo key="v" />,
        <NextButton key="b" className="mt-8" onClick={() => { setDir('next'); setShow(false); }}>Continue</NextButton>,
      ]}
    />
  );
};

const SelectCard = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      'p-6 border shadow-lg rounded-2xl bg-card w-100 max-w-full',
      'hover:bg-accent cursor-pointer transition-all',
      'flex flex-col gap-2',
      className
    )}
    {...props}
  />
);

const SelectStep: React.FC<StepProps> = ({ onPrev }) => {
  const router = useRouter();
  const { setVisited } = useOnboardingStore();
  const [show, setShow] = useState(true);
  const [dir, setDir] = useState<'next' | 'prev'>('next');

  const handleGetStarted = () => {
    setVisited(true);
    setDir('next');
    setShow(false);
  };

  return (
    <StepShell
      show={show}
      onAnimationEnd={() => (dir === 'next' ? router.push('/sign-in') : onPrev?.())}
      items={[
        <Logo key="logo" />,
        <Title key="t">Ready to experience Entry!?</Title>,
        <Caption key="c">Spec & context engineering give agents structure to plan, score, and surface options. You stay in control of the final call. Achieve more, struggle less.</Caption>,
        <div key="cards" className="flex items-stretch gap-4 w-full max-w-[480px] flex-wrap justify-center">
          <SelectCard key="get-started" onClick={handleGetStarted} className="h-full">
            <svg width="24" height="24" viewBox="0 0 24 24" className="text-primary" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M5 12h14" />
              <path d="M12 5l7 7-7 7" />
            </svg>
            <p className="font-semibold text-lg leading-[26px] text-foreground">Get Started</p>
            <p className="text-sm text-muted-foreground leading-[22px]">Create your account and start using Entry right away</p>
            <ul className="text-foreground text-sm space-y-1 mt-1">
              <li>✓ &nbsp;Full access to all multi-agent features</li>
              <li>✓ &nbsp;Save and replay your conversations</li>
              <li>✓ &nbsp;No waitlist, no approval needed</li>
            </ul>
          </SelectCard>
        </div>,
        <BackButton key="back" onClick={() => { setDir('prev'); setShow(false); }}>Back</BackButton>,
      ]}
    />
  );
};

export default function OnboardingPage() {
  const { step, nextStep, prevStep } = useOnboardingStore();
  const el = useMemo(() => {
    switch (step) {
      case OnboardingStep.Welcome:
        return <WelcomeStep onNext={nextStep} />;
      case OnboardingStep.MultiAgent:
        return <MultiAgentStep onNext={nextStep} onPrev={prevStep} />;
      case OnboardingStep.TodoList:
        return <TodoListStep onNext={nextStep} onPrev={prevStep} />;
      case OnboardingStep.Showcase:
        return <ShowcaseStep onNext={nextStep} onPrev={prevStep} />;
      case OnboardingStep.Select:
        return <SelectStep onPrev={prevStep} />;
      default:
        return null;
    }
  }, [step, nextStep, prevStep]);

  return <div className="min-h-screen flex flex-col items-center justify-center bg-background px-4">{el}</div>;
}
