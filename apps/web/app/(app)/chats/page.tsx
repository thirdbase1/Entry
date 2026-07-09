'use client';

import { useSearchParams } from 'next/navigation';
import { ChatInterface } from '@/components/chat/chat-interface';

export default function NewChatPage() {
  const searchParams = useSearchParams();
  return (
    <div className="flex-1 panel h-full">
      <ChatInterface
        placeholder="What can I help you with?"
        placeholderTitle="What can I help you with?"
        className="flex-1"
        initialMessage={searchParams.get('msg') ?? undefined}
      />
    </div>
  );
}
