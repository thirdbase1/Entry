'use client';

import { Suspense, use } from 'react';
import { ChatInterface } from '@/components/chat/chat-interface';
import { ChatPageHeader } from '@/components/chat/chat-page-header';
import { IntegrationCallbackReader } from '@/components/chat/integration-callback-reader';

export default function ChatSessionPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = use(params);

  return (
    <div className="flex-1 panel h-full">
      <Suspense fallback={null}>
        <IntegrationCallbackReader>
          {integrationCallback => (
            <ChatInterface
              sessionId={sessionId}
              placeholder="What can I help you with?"
              className="flex-1"
              integrationCallback={integrationCallback}
              // ChatPageHeader now reads `?version=N` via useSearchParams (see
              // its own file comment, 2026-07-17) -- Next's app router requires
              // any client component using that hook to sit under a Suspense
              // boundary, so it doesn't force this whole route out of static
              // optimization eligibility for every other consumer.
              headerContent={
                <Suspense fallback={null}>
                  <ChatPageHeader sessionId={sessionId} />
                </Suspense>
              }
            />
          )}
        </IntegrationCallbackReader>
      </Suspense>
    </div>
  );
}
