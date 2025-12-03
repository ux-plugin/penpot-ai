import { Routes, Route, Navigate, Outlet } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import Login from "@views/Login.tsx";
import Home from "@views/Home.tsx";
import { useAuthenticationStore } from "@stores/useAuthenticationStore.ts";
import { usePortUpdatesStore } from "@stores/usePortUpdatesStore.ts";
import { initializePortSubscription, cleanupPortSubscription } from "@api/user/portSubscriptionManager.ts";
import { connectRSocket, disconnectRSocket } from "@api/rsocket.ts";
import { handlePortUpdate } from "@api/companion";
import { useCompletionsWebSocket, CompletionsWebSocketProvider } from "@api/completions";
import { WindowResizeHandle } from '@components/WindowResizeHandle.tsx';
import { ResizeIconBottomRight } from '@components/ResizeIcons.tsx';


const NonAuthenticatedLayout = () => {
  const { isAuthenticated } = useAuthenticationStore();
  return !isAuthenticated ? <Outlet /> : <Navigate to="/home" replace />;
};

const AuthenticatedLayout = () => {
  const { isAuthenticated } = useAuthenticationStore();
  const { currentPort } = usePortUpdatesStore();
  const hasInitialized = useRef(false);

  // Initialize RSocket and port subscription when user authenticates
  useEffect(() => {
    if (isAuthenticated && !hasInitialized.current) {
      console.log("User authenticated - running initialization");

      // Ensure RSocket connection and subscribe to ports stream
      console.log("Initializing RSocket + port subscription manager...");
      connectRSocket()
        .then(() => initializePortSubscription())
        .catch((error) => {
          console.error("Failed to connect to RSocket:", error);
        });
      
      hasInitialized.current = true;
    }

    if (!isAuthenticated && hasInitialized.current) {
      console.log("User logged out - cleaning up");
      
      // Clean up port subscription
      cleanupPortSubscription();
      
      // Disconnect RSocket (shared)
      disconnectRSocket();
      
      hasInitialized.current = false;
    }
  }, [isAuthenticated]);

  // Handle port changes (only when authenticated)
  useEffect(() => {
    if (isAuthenticated && currentPort) {
      console.log(`Port changed to ${currentPort}, triggering reconnection...`);
      handlePortUpdate(currentPort).catch((error) => {
        console.error('Failed to reconnect after port update:', error);
      });
    }
  }, [currentPort, isAuthenticated]);

  return isAuthenticated ? <Outlet /> : <Navigate to="/login" replace />;
};

function AppContent() {
  const { isAuthenticated } = useAuthenticationStore();
  const [responsesCount, setResponsesCount] = useState(0);

  // Use completions WebSocket hook for audio streaming to backend
  const {
    startRecordingAndStreaming,
    stopRecordingAndStreaming,
    isRecording,
    isWebSocketConnected,
    recordingError,
    webSocketError,
  } = useCompletionsWebSocket({
    onWebSocketOpen: () => {
      console.log('✅ WebSocket connected to backend!');
      setResponsesCount(0);
    },
    
    onWebSocketClose: () => {
      console.log('🔌 WebSocket closed');
    },
    
    onWebSocketError: (error) => {
      console.error('❌ WebSocket error:', error);
    },
    
    onReasoningChunk: (reasoning) => {
      console.log(`📨 Backend reasoning chunk:`, reasoning);
    },
    
    onAction: (action) => {
      console.log(`📨 Backend action:`, action);
      // Count actions as responses
      setResponsesCount((prev) => prev + 1);
    },
    
    onText: (text) => {
      console.log(`📨 Backend text chunk:`, text);
    },
  });

  // Log errors
  useEffect(() => {
    if (recordingError) {
      console.error('❌ Recording error:', recordingError);
    }
    if (webSocketError) {
      console.error('❌ WebSocket error:', webSocketError);
    }
  }, [recordingError, webSocketError]);

  // Log streaming status
  useEffect(() => {
    if (isRecording && isWebSocketConnected) {
      console.log('🎙️ Streaming active - Recording:', isRecording, 'WebSocket:', isWebSocketConnected);
    }
  }, [isRecording, isWebSocketConnected]);

  // Keyboard shortcut for audio recording and streaming
  useEffect(() => {
    const handleKeyDown = async (event: KeyboardEvent) => {
      // Toggle recording with Ctrl+K or Cmd+K
      if ((event.ctrlKey || event.metaKey) && event.key === 'k') {
        event.preventDefault();
        
        if (isRecording) {
          console.log('⏹️ Stopping recording and WebSocket...');
          stopRecordingAndStreaming();
          console.log(`✅ Stopped. Total responses received: ${responsesCount}`);
        } else {
          console.log('🎙️ Starting recording and WebSocket streaming...');
          try {
            await startRecordingAndStreaming();
            console.log('✅ Recording and streaming started successfully');
          } catch (error) {
            console.error('❌ Failed to start recording and streaming:', error);
          }
        }
      }
    };

    console.log('🎯 Keyboard listener initialized (Cmd/Ctrl+K for audio streaming)');
    window.addEventListener('keydown', handleKeyDown);
    
    return () => {
      console.log('🧹 Keyboard listener cleaned up');
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isRecording, startRecordingAndStreaming, stopRecordingAndStreaming, responsesCount]);

  return (
    <>
      <Routes>
        <Route element={<NonAuthenticatedLayout />}>
          <Route path="/login" element={<Login />} />
        </Route>

        <Route element={<AuthenticatedLayout />}>
          <Route path="/home" element={<Home />} />
        </Route>

        <Route
          path="*"
          element={isAuthenticated ? <Navigate to="/home" replace /> : <Navigate to="/login" replace />}
        />
      </Routes>
      
      {/* Resize handle available on all pages */}
      <WindowResizeHandle>
        <ResizeIconBottomRight />
      </WindowResizeHandle>
    </>
  );
}

// Wrap App with CompletionsWebSocketProvider
function App() {
  return (
    <CompletionsWebSocketProvider>
      <AppContent />
    </CompletionsWebSocketProvider>
  );
}

export default App;
