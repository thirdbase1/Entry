'use client';

import { SignOutIcon } from '@blocksuite/icons/rc';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/auth';

export function UserInfo() {
  const { user, logout } = useAuthStore();
  const router = useRouter();

  const handleLogout = async () => {
    if (!confirm('Are you sure you want to sign out?')) return;
    await logout();
    router.push('/sign-in');
  };

  const displayName = user?.name || user?.email || 'User';
  const initials = displayName
    .split(' ')
    .map(w => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <div className="flex items-center justify-between px-1 gap-2 h-[42px]">
      <div
        className="flex items-center justify-center w-6 h-6 rounded-full text-xs font-medium text-primary-foreground"
        style={{ backgroundColor: 'hsl(var(--primary))' }}
      >
        {initials}
      </div>
      <div className="text-sm w-0 flex-1 truncate flex items-center font-medium text-foreground">
        {displayName}
      </div>
      <button
        onClick={handleLogout}
        title="Sign out"
        className="p-1 rounded hover:bg-accent transition-colors"
      >
        <SignOutIcon className="w-5 h-5 text-muted-foreground" />
      </button>
    </div>
  );
}
