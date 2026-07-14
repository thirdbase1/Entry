'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MainLayout } from '@/components/layout/main-layout';
import { useAuthStore } from '@/store/auth';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { user, isLoading, refreshSession } = useAuthStore();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    refreshSession().finally(() => setChecked(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (checked && !isLoading && !user) {
      router.replace('/sign-in');
    }
  }, [checked, isLoading, user, router]);

  if (!checked || isLoading || !user) {
    return <div className="flex items-center justify-center h-dvh text-muted-foreground text-sm">Loading…</div>;
  }

  return <MainLayout>{children}</MainLayout>;
}
