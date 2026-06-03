/**
 * Conversation store for managing chat messages with audio and streaming support
 */

import { create } from 'zustand';

export interface Message {
  id: string;
  type: 'user' | 'ai';
  content: string;
  timestamp: number;
  audioData?: string; // Base64 encoded audio for user messages
  isStreaming?: boolean; // Flag for AI messages being streamed
  
  // AI response fields (streamed separately)
  reasoning?: string; // AI reasoning process (displayed in collapsible section)
  text?: string; // Actual response text
}

export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  lastUpdated: number;
}

interface ConversationState {
  conversations: Conversation[];
  currentConversationId: string | null;
  
  // Actions
  addConversation: (conversation: Conversation) => void;
  setCurrentConversation: (conversationId: string) => void;
  addMessage: (conversationId: string, message: Message) => void;
  updateMessage: (conversationId: string, messageId: string, updates: Partial<Message>) => void;
  appendToMessage: (conversationId: string, messageId: string, content: string) => void;
  getCurrentConversation: () => Conversation | undefined;
}

export const useConversationStore = create<ConversationState>((set, get) => ({
  conversations: [],
  currentConversationId: null,
  
  addConversation: (conversation) => set((state) => ({
    conversations: [conversation, ...state.conversations],
    currentConversationId: conversation.id,
  })),
  
  setCurrentConversation: (conversationId) => set({
    currentConversationId: conversationId,
  }),
  
  addMessage: (conversationId, message) => set((state) => ({
    conversations: state.conversations.map((conv) =>
      conv.id === conversationId
        ? {
            ...conv,
            messages: [...conv.messages, message],
            lastUpdated: Date.now(),
          }
        : conv
    ),
  })),
  
  updateMessage: (conversationId, messageId, updates) => set((state) => ({
    conversations: state.conversations.map((conv) =>
      conv.id === conversationId
        ? {
            ...conv,
            messages: conv.messages.map((msg) =>
              msg.id === messageId ? { ...msg, ...updates } : msg
            ),
            lastUpdated: Date.now(),
          }
        : conv
    ),
  })),
  
  appendToMessage: (conversationId, messageId, content) => set((state) => ({
    conversations: state.conversations.map((conv) =>
      conv.id === conversationId
        ? {
            ...conv,
            messages: conv.messages.map((msg) =>
              msg.id === messageId
                ? { ...msg, content: msg.content + content }
                : msg
            ),
            lastUpdated: Date.now(),
          }
        : conv
    ),
  })),
  
  getCurrentConversation: () => {
    const state = get();
    return state.conversations.find((c) => c.id === state.currentConversationId);
  },
}));
