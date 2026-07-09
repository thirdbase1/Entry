/**
 * Ported 1:1 from pages/layout/auth-layout.tsx.
 */
import { cn } from '@/lib/utils';
import styles from './auth-layout.module.css';

export function AuthLayout({ children }: { children: React.ReactNode }) {
  return <div className={cn(styles.root, 'bg-layer-background-secondary')}>{children}</div>;
}
