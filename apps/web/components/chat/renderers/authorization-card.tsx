'use client';

import type { EveAuthorizationPart } from 'eve/react';

export function AuthorizationCard({ part }: { part: EveAuthorizationPart }) {
  if (part.state === 'completed') {
    return (
      <div className="rounded-lg border border-border bg-card w-full p-3 text-sm">
        {part.outcome === 'authorized' ? (
          <span className="text-foreground">{part.displayName} connected.</span>
        ) : (
          <span className="text-muted-foreground">
            {part.displayName} authorization {part.outcome}.
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card w-full p-4 space-y-2">
      <div className="text-sm font-medium text-foreground">{part.displayName}</div>
      <p className="text-sm text-muted-foreground">{part.description}</p>
      {part.authorization?.userCode && (
        <code className="block text-sm bg-muted rounded px-2 py-1 w-fit">{part.authorization.userCode}</code>
      )}
      {part.authorization?.url && (
        <a
          href={part.authorization.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 h-9 px-4"
        >
          Sign in
        </a>
      )}
    </div>
  );
}
