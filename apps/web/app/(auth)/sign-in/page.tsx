/**
 * Ported from pages/sign-in.tsx. Behavior 1:1 with the original; the only
 * structural change is react-router's `useNavigate`/`useSearchParams` →
 * Next.js's `useRouter`/`useSearchParams` (App Router equivalents, same
 * client-side navigation semantics). GraphQL's `OAuthProviderType` enum
 * is replaced with a plain string union since this migration replaced
 * GraphQL with REST throughout (Phase 2). Apple is not a supported
 * provider — dropped per instruction; only Google is offered, matching
 * the original (which also only rendered a Google button, no Apple UI
 * existed to remove).
 */
'use client';
import { GoogleDuotoneIcon, GithubDuotoneIcon } from '@blocksuite/icons/rc';
import { AnimatePresence, motion } from 'framer-motion';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { RowInput } from '@/components/ui/row-input';
import { CodeInput } from '@/components/ui/code-input';
import { useAuthStore } from '@/store/auth';

import { AuthLayout } from '../auth-layout';
import styles from './sign-in.module.css';

type Step = 'methodSelect' | 'password' | 'magic';
type OAuthProvider = 'Google' | 'GitHub';

const providerIcons: Record<OAuthProvider, React.ReactNode> = {
  Google: <GoogleDuotoneIcon />,
  GitHub: <GithubDuotoneIcon />,
};

function OAuthButton({ provider, redirectUrl }: { provider: OAuthProvider; redirectUrl?: string }) {
  const handleClick = async () => {
    try {
      const { authClient } = await import('@/lib/auth-client');
      await authClient.signIn.social({
        provider: provider.toLowerCase(),
        callbackURL: redirectUrl ?? '/chats',
      });
    } catch {
      // stay on the page; user can retry
    }
  };

  return (
    <button onClick={handleClick} className={styles.oauthButton}>
      {providerIcons[provider] ?? null}
      Continue with {provider}
    </button>
  );
}

function SignInPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectUrl = searchParams.get('redirect') || '/chats';

  const { user, isLoading, error, clearError, checkUserByEmail, signInPassword, sendMagicLink, verifyMagicLink } = useAuthStore();

  const [step, setStep] = useState<Step>('methodSelect');
  const [email, setEmail] = useState('');
  const [hasPassword, setHasPassword] = useState<boolean | null>(null);
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (!isLoading && user) router.replace(redirectUrl);
  }, [isLoading, router, redirectUrl, user]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setInterval(() => setCooldown(c => c - 1), 1000);
    return () => clearInterval(id);
  }, [cooldown]);

  const handleEmailContinue = async () => {
    clearError();
    if (!email) return;
    try {
      const info = await checkUserByEmail(email);
      setHasPassword(info.hasPassword);
      if (!info.canSignIn) return;
      if (info.hasPassword) {
        setStep('password');
      } else {
        await sendMagicLink(email, { redirectUrl });
        setCooldown(60);
        setStep('magic');
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handlePasswordLogin = async () => {
    clearError();
    try {
      await signInPassword(email, password);
      router.replace(redirectUrl);
    } catch {
      /* handled by store */
    }
  };

  const handleVerifyOtp = async () => {
    clearError();
    if (otp.length !== 6) return;
    try {
      await verifyMagicLink(email, otp);
      router.replace(redirectUrl);
    } catch {}
  };

  const resendOtp = async () => {
    if (cooldown > 0) return;
    await sendMagicLink(email, { redirectUrl });
    setCooldown(60);
  };

  return (
    <AuthLayout>
      <div className={styles.wrapper}>
        {step === 'methodSelect' && (
          <>
            <h2 className={styles.title}>Welcome Back</h2>
            <RowInput
              type="email"
              placeholder="Email address"
              value={email}
              onChange={e => {
                setEmail(e);
                clearError();
              }}
              className={cn(styles.input, 'px-2 py-1', error ? 'border-red-600!' : 'border-black!', 'outline-black')}
              autoComplete="email"
              required
              autoFocus
              onEnter={() => void handleEmailContinue()}
            />
            <AnimatePresence>
              {error ? (
                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }}>
                  <p className="text-[15px] text-red-600 mt-2 font-medium">{error}</p>
                </motion.div>
              ) : null}
            </AnimatePresence>
            <button onClick={() => void handleEmailContinue()} className={cn(styles.submit, 'mt-4')} disabled={!email || isLoading} aria-disabled={!email || isLoading}>
              Continue with email
            </button>
            <div className={styles.or}>
              <div className={cn('flex-1', styles.line)} />
              <span className={styles.orText}>OR</span>
              <div className={cn('flex-1', styles.line, 'reverse')} />
            </div>
            <OAuthButton provider="Google" redirectUrl={redirectUrl} />
          </>
        )}

        {step === 'password' && (
          <>
            <h2 className="text-xl font-bold mb-4 text-center">Enter Password</h2>
            <p className="text-sm mb-2 text-gray-700">{email}</p>
            <input
              type="password"
              autoFocus
              placeholder="Password"
              className="w-full px-3 py-2 border rounded mb-3"
              value={password}
              onChange={e => setPassword(e.target.value)}
            />
            {error && <p className="text-sm text-red-600 mb-2">{error}</p>}
            <button onClick={() => void handlePasswordLogin()} className={cn(styles.submit, 'mt-8')} disabled={!password || isLoading}>
              Sign in
            </button>
            <button
              onClick={() => {
                void (async () => {
                  await sendMagicLink(email, { redirectUrl });
                  setCooldown(60);
                  setStep('magic');
                })();
              }}
              className="mt-3 w-full text-sm text-indigo-600 hover:underline"
            >
              Use a 6-digit code instead
            </button>
          </>
        )}

        {step === 'magic' && (
          <>
            <h2 className={styles.title}>Verify your email</h2>
            <p className={styles.hit}>
              We&apos;ve sent to a security code to <br />
              <span className={styles.hitEmail}>{email}</span>, please enter the code
            </p>
            <div className="flex justify-center mt-8">
              <CodeInput className={styles.codeInput} value={otp} onChange={setOtp} fieldWidth={43} fieldHeight={43} autoFocus />
            </div>
            {error && <p className="text-sm text-red-600 mb-2">{error}</p>}
            <div className="flex justify-center mt-4">
              <Button onClick={() => void resendOtp()} disabled={cooldown > 0}>
                {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}
              </Button>
            </div>
            <button onClick={() => void handleVerifyOtp()} className={cn(styles.submit, 'mt-8')} disabled={otp.length !== 6 || isLoading} aria-disabled={otp.length !== 6 || isLoading}>
              Verify & Sign in
            </button>
            {hasPassword && (
              <button onClick={() => setStep('password')} className="mt-2 w-full text-sm text-indigo-600 hover:underline">
                Use password instead
              </button>
            )}
            <div onClick={() => setStep('methodSelect')} className={cn('mt-4', styles.oauthButton)}>
              Back
            </div>
          </>
        )}
      </div>
    </AuthLayout>
  );
}

export default function SignInPage() {
  return (
    <Suspense fallback={null}>
      <SignInPageInner />
    </Suspense>
  );
}
