import React, { useState, useRef, useEffect } from 'react';
import { Button } from '@ui/button';
import { Input } from '@ui/input';
import { Send, MessageSquare, History, ChevronLeft } from 'lucide-react';

interface Message {
  id: string;
  type: 'user' | 'ai';
  content: string;
  timestamp: number;
}

interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  lastUpdated: number;
}

export function ConversationHistory() {
  const [showHistory, setShowHistory] = useState(false);
  const [currentMessage, setCurrentMessage] = useState('');
  const [currentConversationId, setCurrentConversationId] = useState('1');
  
  // Mock data - will be replaced with actual state management
  const [conversations, setConversations] = useState<Conversation[]>([
    {
      id: '1',
      title: 'New Conversation',
      messages: [
        {
          id: 'm1',
          type: 'user',
          content: 'Hello! Can you help me create a button?',
          timestamp: Date.now() - 60000,
        },
        {
          id: 'm2',
          type: 'ai',
          content: 'Of course! I can help you create a button. What style would you like?',
          timestamp: Date.now() - 50000,
        },
      ],
      lastUpdated: Date.now(),
    },
    {
      id: '2',
      title: 'UI Design Discussion',
      messages: [
        {
          id: 'm3',
          type: 'user',
          content: 'What are best practices for spacing?',
          timestamp: Date.now() - 120000,
        },
      ],
      lastUpdated: Date.now() - 120000,
    },
  ]);

  const currentConversation = conversations.find(c => c.id === currentConversationId);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom when messages change
  useEffect(() => {
    if (!showHistory) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [currentConversation?.messages, showHistory]);

  const handleSendMessage = () => {
    if (!currentMessage.trim()) return;

    const newMessage: Message = {
      id: `m${Date.now()}`,
      type: 'user',
      content: currentMessage,
      timestamp: Date.now(),
    };

    setConversations(prev => prev.map(conv => 
      conv.id === currentConversationId 
        ? { 
            ...conv, 
            messages: [...conv.messages, newMessage],
            lastUpdated: Date.now(),
          }
        : conv
    ));

    setCurrentMessage('');

    // Simulate AI response
    setTimeout(() => {
      const aiMessage: Message = {
        id: `m${Date.now()}`,
        type: 'ai',
        content: 'I understand. Let me help you with that.',
        timestamp: Date.now(),
      };

      setConversations(prev => prev.map(conv => 
        conv.id === currentConversationId 
          ? { 
              ...conv, 
              messages: [...conv.messages, aiMessage],
              lastUpdated: Date.now(),
            }
          : conv
      ));
    }, 1000);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const selectConversation = (conversationId: string) => {
    setCurrentConversationId(conversationId);
    setShowHistory(false);
  };

  const startNewConversation = () => {
    const newConv: Conversation = {
      id: `conv${Date.now()}`,
      title: 'New Conversation',
      messages: [],
      lastUpdated: Date.now(),
    };
    setConversations(prev => [newConv, ...prev]);
    setCurrentConversationId(newConv.id);
    setShowHistory(false);
  };

  // Content for the panel
  return (
    <div className="flex flex-col h-full -m-4">
      {/* Header Actions */}
      <div className="flex items-center justify-between p-4 border-b border-gray-200 bg-gray-50">
        <div className="flex items-center gap-2">
          {showHistory && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setShowHistory(false)}
              className="text-gray-700 hover:bg-gray-200"
            >
              <ChevronLeft className="h-5 w-5" />
            </Button>
          )}
          <h4 className="font-medium text-gray-900">
            {showHistory ? 'History' : currentConversation?.title || 'Chat'}
          </h4>
        </div>
        {!showHistory && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setShowHistory(true)}
            className="text-gray-700 hover:bg-gray-200"
            title="View History"
          >
            <History className="h-5 w-5" />
          </Button>
        )}
      </div>

      {/* Conversation History View */}
      {showHistory ? (
        <div className="flex-1 overflow-y-auto p-4 bg-white">
          <Button
            onClick={startNewConversation}
            className="w-full mb-4 bg-gray-900 hover:bg-gray-800 text-white"
          >
            Start New Conversation
          </Button>
          <div className="space-y-2">
            {conversations.map(conv => (
              <button
                key={conv.id}
                onClick={() => selectConversation(conv.id)}
                className={`w-full text-left p-3 rounded-lg border transition-colors ${
                  conv.id === currentConversationId
                    ? 'bg-gray-100 border-gray-400'
                    : 'bg-white border-gray-200 hover:bg-gray-50'
                }`}
              >
                <div className="font-medium text-gray-900">{conv.title}</div>
                <div className="text-sm text-gray-500 truncate">
                  {conv.messages[conv.messages.length - 1]?.content || 'No messages yet'}
                </div>
                <div className="text-xs text-gray-400 mt-1">
                  {new Date(conv.lastUpdated).toLocaleString()}
                </div>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <>
          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {currentConversation?.messages.length === 0 ? (
              <div className="flex items-center justify-center h-full text-gray-400">
                <div className="text-center">
                  <MessageSquare className="h-12 w-12 mx-auto mb-2 opacity-50" />
                  <p>Start a conversation</p>
                </div>
              </div>
            ) : (
              currentConversation?.messages.map(message => (
                <div
                  key={message.id}
                  className={`flex ${message.type === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[80%] rounded-lg px-4 py-2 ${
                      message.type === 'user'
                        ? 'bg-gray-900 text-white'
                        : 'bg-gray-100 text-gray-900'
                    }`}
                  >
                    <p className="text-sm">{message.content}</p>
                    <p className={`text-xs mt-1 ${
                      message.type === 'user' ? 'text-gray-400' : 'text-gray-500'
                    }`}>
                      {new Date(message.timestamp).toLocaleTimeString()}
                    </p>
                  </div>
                </div>
              ))
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="p-4 border-t border-gray-200 bg-gray-50">
            <div className="flex items-center gap-2">
              <Input
                value={currentMessage}
                onChange={(e) => setCurrentMessage(e.target.value)}
                onKeyPress={handleKeyPress}
                placeholder="Type your message..."
                className="flex-1"
              />
              <Button
                onClick={handleSendMessage}
                disabled={!currentMessage.trim()}
                className="bg-blue-600 hover:bg-blue-700"
                size="icon"
              >
                <Send className="h-5 w-5" />
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
