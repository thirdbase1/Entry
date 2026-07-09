'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MainLayout } from '@/components/layout/main-layout';
import { OpenDocProvider, useOpenDocContext } from '@/contexts/doc-panel-context';
import { DocPanel } from '@/components/doc-panel/doc-panel';
import { useAuthStore } from '@/store/auth';

function AppShell({ children }: { children: React.ReactNode }) {
  const { activeDocId, closeDoc } = useOpenDocContext();

  return (
    <MainLayout>
      {children}
      {activeDocId && (
        <div className="flex-1 panel h-full">
          <DocPanel docId={activeDocId} onClose={closeDoc} />
        </div>
      )}
    </MainLayout>
  );
}

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
    return <div className="flex items-center justify-center h-screen text-muted-foreground text-sm">Loading…</div>;
  }

  return (
    <OpenDocProvider>
      <AppShell>{children}</AppShell>
    </OpenDocProvider>
  );
}
