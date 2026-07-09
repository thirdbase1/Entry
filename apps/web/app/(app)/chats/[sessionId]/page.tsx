'use client';

import { use } from 'react';
import { ChatInterface } from '@/components/chat/chat-interface';
import { ChatPageHeader } from '@/components/chat/chat-page-header';

export default function ChatSessionPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = use(params);

  return (
    <div className="flex-1 panel h-full">
      <ChatInterface
        sessionId={sessionId}
        placeholder="What can I help you with?"
        className="flex-1"
        headerContent={<ChatPageHeader sessionId={sessionId} />}
      />
    </div>
  );
}
