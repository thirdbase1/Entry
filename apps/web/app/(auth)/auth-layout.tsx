/**
 * Ported 1:1 from pages/layout/auth-layout.tsx.
 * The original defines a `.logo` style (absolute, top: 36px, centered,
 * 36×36px) but never renders it. Per the project's confirmed rebrand,
 * the logo is now /public/logo.jpg (not the original SVG) and is rendered
 * here using the original's exact positioning values.
 */
import { cn } from '@/lib/utils';
import styles from './auth-layout.module.css';

export function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={cn(styles.root, 'bg-layer-background-secondary')}>
      <img src="/logo.jpg" alt="Entry" className={styles.logo} />
      {children}
    </div>
  );
}
