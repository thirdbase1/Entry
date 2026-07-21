import './globals.css';
import type { Metadata } from 'next';
import { ThemeProvider } from '@/components/theme-provider';
import { ErrorBoundary } from '@/components/error-boundary';

export const metadata: Metadata = {
  title: 'Entry',
  description: 'Your AI-powered workspace',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: required by next-themes — it sets the
    // data-theme attribute on <html> via an inline script that runs before
    // React hydrates (so there's no flash of the wrong theme), which
    // otherwise makes React warn about a server/client attribute mismatch
    // that isn't actually a bug.
    <html lang="en" suppressHydrationWarning>
      <body>
        {/* Root error boundary (2026-07-21): a render-time crash ANYWHERE
            in the tree used to unmount silently -- no visible sign the
            page is dead, indistinguishable from "click didn't register".
            Now it always surfaces a real "Something broke" fallback with
            a reload button, and reports to /api/client-error so it shows
            up server-side even if nobody's watching the browser console. */}
        <ErrorBoundary region="root">
          <ThemeProvider>{children}</ThemeProvider>
        </ErrorBoundary>
      </body>
    </html>
  );
}
