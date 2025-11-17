import React, { useState, useRef, useEffect } from 'react';
import { Button } from '@ui/button';
import { Input } from '@ui/input';
import { Send, MessageSquare, History, ChevronLeft, Mic, Play, Pause } from 'lucide-react';
import { useConversationStore, type Message, type Conversation } from '../stores/useConversationStore';
import { useCompletionsWebSocket } from '../api/useCompletionsWebSocket';

export function ConversationHistory() {
  const [showHistory, setShowHistory] = useState(false);
  const [currentMessage, setCurrentMessage] = useState('');
  const [playingAudioId, setPlayingAudioId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  
  // Use conversation store
  const {
    conversations,
    currentConversationId,
    addConversation,
    setCurrentConversation,
    addMessage,
    updateMessage,
    appendToMessage,
    getCurrentConversation,
  } = useConversationStore();
  
  // Initialize with a default conversation if none exists
  useEffect(() => {
    if (conversations.length === 0) {
      const defaultConv: Conversation = {
        id: 'conv_default',
        title: 'New Conversation',
        messages: [],
        lastUpdated: Date.now(),
      };
      addConversation(defaultConv);
    }
  }, [conversations.length, addConversation]);
  
  const currentConversation = getCurrentConversation();
  
  // Set up WebSocket for streaming responses
  const {
    startRecordingAndStreaming,
    stopRecordingAndStreaming,
    isRecording,
    isReady,
  } = useCompletionsWebSocket({
    onCompletionResponse: (response) => {
      if (!currentConversationId) return;
      
      const { reasoning } = response.payload;
      
      // Find or create streaming AI message
      const streamingMessage = currentConversation?.messages.find(
        (m) => m.isStreaming && m.type === 'ai'
      );
      
      if (streamingMessage) {
        // Append to existing streaming message
        appendToMessage(currentConversationId, streamingMessage.id, ' ' + reasoning);
      } else {
        // Create new streaming message
        const newMessage: Message = {
          id: `msg_${Date.now()}`,
          type: 'ai',
          content: reasoning,
          timestamp: Date.now(),
          isStreaming: true,
        };
        addMessage(currentConversationId, newMessage);
      }
    },
  });
  
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom when messages change
  useEffect(() => {
    if (!showHistory) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [currentConversation?.messages, showHistory]);

  const handleSendMessage = () => {
    if (!currentMessage.trim() || !currentConversationId) return;

    const newMessage: Message = {
      id: `msg_${Date.now()}`,
      type: 'user',
      content: currentMessage,
      timestamp: Date.now(),
    };

    addMessage(currentConversationId, newMessage);
    setCurrentMessage('');
  };
  
  const handleStartRecording = async () => {
    if (!currentConversationId) return;
    
    try {
      await startRecordingAndStreaming();
    } catch (error) {
      console.error('Failed to start recording:', error);
    }
  };
  
  const handleStopRecording = () => {
    if (!currentConversationId) return;
    
    stopRecordingAndStreaming();
    
    // Mark the streaming message as complete
    const streamingMessage = currentConversation?.messages.find(
      (m) => m.isStreaming && m.type === 'ai'
    );
    
    if (streamingMessage && currentConversationId) {
      updateMessage(currentConversationId, streamingMessage.id, { isStreaming: false });
    }
  };
  
  const handlePlayAudio = (messageId: string, audioData: string) => {
    if (playingAudioId === messageId) {
      // Pause current audio
      audioRef.current?.pause();
      setPlayingAudioId(null);
    } else {
      // Play new audio
      if (audioRef.current) {
        audioRef.current.pause();
      }
      
      // Convert base64 to audio blob and play
      const audio = new Audio(`data:audio/webm;base64,${audioData}`);
      audioRef.current = audio;
      audio.onended = () => setPlayingAudioId(null);
      audio.play().catch(console.error);
      setPlayingAudioId(messageId);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const selectConversation = (conversationId: string) => {
    setCurrentConversation(conversationId);
    setShowHistory(false);
  };

  const startNewConversation = () => {
    const newConv: Conversation = {
      id: `conv_${Date.now()}`,
      title: 'New Conversation',
      messages: [],
      lastUpdated: Date.now(),
    };
    addConversation(newConv);
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
                    {message.audioData && (
                      <div className="mb-2 flex items-center gap-2">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => handlePlayAudio(message.id, message.audioData!)}
                        >
                          {playingAudioId === message.id ? (
                            <Pause className="h-4 w-4" />
                          ) : (
                            <Play className="h-4 w-4" />
                          )}
                        </Button>
                        <span className="text-xs opacity-75">Audio message</span>
                      </div>
                    )}
                    <p className="text-sm">
                      {message.content}
                      {message.isStreaming && <span className="animate-pulse ml-1">▋</span>}
                    </p>
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
              <Button
                onClick={isRecording ? handleStopRecording : handleStartRecording}
                disabled={!isReady}
                className={isRecording ? "bg-red-600 hover:bg-red-700" : "bg-gray-600 hover:bg-gray-700"}
                size="icon"
                title={isRecording ? "Stop Recording" : "Start Voice Recording"}
              >
                <Mic className="h-5 w-5" />
              </Button>
              <Input
                value={currentMessage}
                onChange={(e) => setCurrentMessage(e.target.value)}
                onKeyPress={handleKeyPress}
                placeholder="Type your message..."
                className="flex-1"
                disabled={isRecording}
              />
              <Button
                onClick={handleSendMessage}
                disabled={!currentMessage.trim() || isRecording}
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
