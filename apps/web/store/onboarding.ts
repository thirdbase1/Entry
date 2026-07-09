import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Production onboarding flow (rebrand to Entry, full public launch):
 * Welcome → MultiAgent → TodoList → Showcase → Select.
 *
 * The original had two more steps (Register/Waiting) that captured an email
 * for a beta waitlist and gated access behind early-access approval — that
 * doesn't apply anymore now that Entry is fully live, so the flow ends at
 * Select, which routes straight to /sign-in. The GitHub self-deployment
 * card (this was never a real open-source release path for the production
 * product) was removed for the same reason.
 */
export enum OnboardingStep {
  Welcome = 0,
  MultiAgent,
  TodoList,
  Showcase,
  Select,
}

interface OnboardingState {
  visited: boolean;
  setVisited: (visited: boolean) => void;
  step: OnboardingStep;
  setStep: (step: OnboardingStep) => void;
  nextStep: () => void;
  prevStep: () => void;
}

export const useOnboardingStore = create<OnboardingState>()(
  persist(
    (set, get) => ({
      visited: false,
      setVisited: visited => set({ visited }),
      step: OnboardingStep.Welcome,
      setStep: step => set({ step }),
      nextStep: () => {
        const next = Math.min(get().step + 1, OnboardingStep.Select);
        set({ step: next });
      },
      prevStep: () => {
        const prev = Math.max(get().step - 1, OnboardingStep.Welcome);
        set({ step: prev });
      },
    }),
    { name: 'onboarding-storage', partialize: state => ({ visited: state.visited }) }
  )
);
