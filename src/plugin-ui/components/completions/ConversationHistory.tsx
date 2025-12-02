import React, { useState, useRef, useEffect } from 'react';
import { Button } from '@ui/button';
import { Input } from '@ui/input';
import { Send, MessageSquare, History, ChevronLeft, Mic, Play, Pause} from 'lucide-react';
import { useConversationStore, type Message, type Conversation } from '@/plugin-ui/stores/useConversationStore.ts';
import { useCompletionsWebSocket } from "@/plugin-ui/api/completions";
import { useAudioPlayback } from '@/plugin-ui/api/companion';

export function ConversationHistory() {
  const [showHistory, setShowHistory] = useState(false);
  const [currentMessage, setCurrentMessage] = useState('');
  const [playingAudioId, setPlayingAudioId] = useState<string | null>(null);
  const [recordedAudioChunks, setRecordedAudioChunks] = useState<Uint8Array[]>([]);
  
  // Use audio playback hook for companion app
  const { playAudio, stopAudio } = useAudioPlayback();
  
  // Use conversation store
  const {
    conversations,
    currentConversationId,
    addConversation,
    setCurrentConversation,
    addMessage,
    updateMessage,
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
    onAudioChunk: (base64Audio: string) => {
      // Decode base64 immediately and store as binary
      const binaryString = atob(base64Audio);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      setRecordedAudioChunks((prev) => [...prev, bytes]);
    },
    onReasoningChunk: (reasoning: string) => {
      if (!currentConversationId) return;
      
      // Find or create a streaming AI message
      const streamingMessage = currentConversation?.messages.find(
        (m) => m.isStreaming && m.type === 'ai'
      );
      
      if (streamingMessage) {
        // Append to the reasoning field
        updateMessage(currentConversationId, streamingMessage.id, {
          reasoning: (streamingMessage.reasoning || '') + reasoning
        });
      } else {
        // Create a new streaming message
        const newMessage: Message = {
          id: `msg_${Date.now()}`,
          type: 'ai',
          content: '',
          timestamp: Date.now(),
          isStreaming: true,
          reasoning: reasoning,
        };
        addMessage(currentConversationId, newMessage);
      }
    },
    onText: (text: string) => {
      if (!currentConversationId) return;
      
      // Find or create a streaming AI message
      const streamingMessage = currentConversation?.messages.find(
        (m) => m.isStreaming && m.type === 'ai'
      );
      
      if (streamingMessage) {
        // Append to the text field
        updateMessage(currentConversationId, streamingMessage.id, {
          text: (streamingMessage.text || '') + text
        });
      } else {
        // Create a new streaming message
        const newMessage: Message = {
          id: `msg_${Date.now()}`,
          type: 'ai',
          content: '',
          timestamp: Date.now(),
          isStreaming: true,
          text: text,
        };
        addMessage(currentConversationId, newMessage);
      }
    },
  });
  
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Scroll to the bottom when messages change
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
    
    // Concatenate binary chunks and encode to base64
    let combinedAudio = '';
    if (recordedAudioChunks.length > 0) {
      // Calculate total length
      const totalLength = recordedAudioChunks.reduce((sum, chunk) => sum + chunk.length, 0);
      
      // Concatenate all binary chunks
      const combined = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of recordedAudioChunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }
      
      // Encode to base64
      let binaryString = '';
      for (let i = 0; i < combined.length; i++) {
        binaryString += String.fromCharCode(combined[i]);
      }
      combinedAudio = btoa(binaryString);
    }
    
    // Create a user message with the recorded audio
    if (combinedAudio) {
      const audioMessage: Message = {
        id: `msg_${Date.now()}`,
        type: 'user',
        content: 'Voice message',
        timestamp: Date.now(),
        audioData: combinedAudio,
      };
      addMessage(currentConversationId, audioMessage);
    }
    
    // Clear recorded chunks
    setRecordedAudioChunks([]);
    
    // Mark the streaming message as complete
    const streamingMessage = currentConversation?.messages.find(
      (m) => m.isStreaming && m.type === 'ai'
    );
    
    if (streamingMessage && currentConversationId) {
      updateMessage(currentConversationId, streamingMessage.id, { isStreaming: false });
    }
  };
  
  const handlePlayAudio = async (messageId: string, audioData: string) => {
    if (playingAudioId === messageId) {
      // Stop current audio playback
      stopAudio();
      setPlayingAudioId(null);
    } else {
      // Stop any currently playing audio first
      if (playingAudioId) {
        stopAudio();
      }
      
      try {
        // Play audio through companion app
        setPlayingAudioId(messageId);
        await playAudio(audioData);
        // Audio stopped naturally or by user
        setPlayingAudioId(null);
      } catch (error) {
        console.error('Failed to play audio:', error);
        setPlayingAudioId(null);
      }
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

                    {/* AI Message with reasoning */}
                    {message.type === 'ai' && (message.reasoning || message.text) ? (
                      <div className="space-y-3">
                        {/* Collapsible Reasoning Section */}
                        {(message.reasoning || (message.isStreaming && !message.text)) && (
                          <details className="group" open={message.isStreaming}>
                            <summary className="cursor-pointer font-medium text-sm flex items-center gap-1 list-none">
                              <span>Reasoning</span>
                              <svg 
                                className="w-4 h-4 transition-transform group-open:rotate-90" 
                                fill="none" 
                                stroke="currentColor" 
                                viewBox="0 0 24 24"
                              >
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                              </svg>
                            </summary>
                            <div className="mt-2 p-3 bg-gray-800 text-gray-200 rounded border border-gray-700 text-sm whitespace-pre-wrap">
                              {message.reasoning}
                              {message.isStreaming && !message.text && <span className="animate-pulse ml-1">▋</span>}
                            </div>
                          </details>
                        )}

                        {/* Response Text */}
                        {message.text && (
                          <p className="text-sm whitespace-pre-wrap">
                            {message.text}
                            {message.isStreaming && <span className="animate-pulse ml-1">▋</span>}
                          </p>
                        )}
                      </div>
                    ) : (
                      /* User message or legacy AI message */
                      <p className="text-sm whitespace-pre-wrap">
                        {message.content}
                        {message.isStreaming && <span className="animate-pulse ml-1">▋</span>}
                      </p>
                    )}

                    <p className={`text-xs mt-2 ${
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
