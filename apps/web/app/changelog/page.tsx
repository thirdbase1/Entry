import type { Metadata } from 'next';
import Link from 'next/link';
import { CHANGELOG } from '@/lib/changelog';

export const metadata: Metadata = {
  title: 'Changelog — Entry',
  description: 'Recent fixes and features shipped to Entry.',
};

export default function ChangelogPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-2xl mx-auto px-6 py-16">
        <Link href="/" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
          ← Back
        </Link>
        <h1 className="text-3xl font-semibold mt-6 mb-1">Changelog</h1>
        <p className="text-sm text-muted-foreground mb-12">What&apos;s shipped, most recent first.</p>

        <div className="flex flex-col gap-10">
          {CHANGELOG.map((entry, i) => (
            <div key={`${entry.date}-${i}`} className="border-l-2 border-border pl-5">
              <div className="text-xs text-muted-foreground mb-1">{entry.date}</div>
              <h2 className="text-lg font-medium mb-2">{entry.title}</h2>
              <ul className="flex flex-col gap-1.5">
                {entry.items.map((item, j) => (
                  <li key={j} className="text-sm text-muted-foreground leading-relaxed flex gap-2">
                    <span className="text-foreground/40">•</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
