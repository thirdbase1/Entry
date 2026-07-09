/**
 * Ported 1:1 from pages/layout/auth-layout.tsx.
 * The original defines a `.logo` style (absolute, top: 36px, centered,
 * 36x36px) but never renders it anywhere in the component -- it's dead
 * CSS in the source. True 1:1 parity means no logo renders here either;
 * a previous pass incorrectly added one, now removed.
 */
import { cn } from '@/lib/utils';
import styles from './auth-layout.module.css';

export function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={cn(styles.root, 'bg-layer-background-secondary')}>
      {children}
    </div>
  );
}
