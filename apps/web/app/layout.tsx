import './globals.css';
import type { Metadata } from 'next';
import { ThemeProvider } from '@/components/theme-provider';

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
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
