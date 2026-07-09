'use client';

/**
 * Ported 1:1 from components/chat/messages.context.tsx.
 * Context provider exposing the current chat messages to child components.
 */
import { createContext, useContext } from 'react';

import type { EveMessage } from 'eve/react';

const MessagesContext = createContext<EveMessage[]>([]);

export const MessagesProvider = ({
  children,
  messages,
}: {
  children: React.ReactNode;
  messages: EveMessage[];
}) => {
  return (
    <MessagesContext.Provider value={messages}>
      {children}
    </MessagesContext.Provider>
  );
};

export const useChatMessages = () => {
  return useContext(MessagesContext);
};
