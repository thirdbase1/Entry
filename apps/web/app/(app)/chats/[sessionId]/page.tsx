'use client';

import { Suspense, use } from 'react';
import { ChatInterface } from '@/components/chat/chat-interface';
import { IntegrationCallbackReader } from '@/components/chat/integration-callback-reader';

export default function ChatSessionPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = use(params);

  // ChatPageHeader used to be passed down from here via `headerContent` --
  // moved to render inside DirectChatSession itself (2026-07-23, "chat
  // should be created instantly I send message ... header of preview
  // should show", no reload needed): a brand-new chat's page (the
  // sibling `/chats/page.tsx`, no [sessionId] segment) has no way to know
  // the chat's id yet to pass a header down for it, since the id is only
  // generated once DirectChatSession's own useChat instance mounts. See
  // direct-chat-interface.tsx's `activeId` comment for the full reasoning.
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
            />
          )}
        </IntegrationCallbackReader>
      </Suspense>
    </div>
  );
}
