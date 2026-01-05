import { Routes, Route, Navigate, Outlet } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import Login from "@views/Login.tsx";
import HomePixi from "@views/HomePixi.tsx";
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
      // Ensure RSocket connection and subscribe to ports stream
      connectRSocket()
        .then(() => initializePortSubscription())
        .catch((error) => {
          console.error("Failed to connect to RSocket:", error);
        });

      hasInitialized.current = true;
    }

    if (!isAuthenticated && hasInitialized.current) {
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
    recordingError,
    webSocketError,
  } = useCompletionsWebSocket({
    onWebSocketOpen: () => {
      setResponsesCount(0);
    },

    onWebSocketClose: () => {
      // WebSocket closed
    },

    onWebSocketError: (error) => {
      console.error('❌ WebSocket error:', error);
    },

    onReasoningChunk: () => {
      // Reasoning chunk received
    },

    onAction: () => {
      // Count actions as responses
      setResponsesCount((prev) => prev + 1);
    },

    onText: () => {
      // Text chunk received
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

  // Keyboard shortcut for audio recording and streaming
  useEffect(() => {
    const handleKeyDown = async (event: KeyboardEvent) => {
      // Toggle recording with Ctrl+K or Cmd+K
      if ((event.ctrlKey || event.metaKey) && event.key === 'k') {
        event.preventDefault();

        if (isRecording) {
          stopRecordingAndStreaming();
        } else {
          try {
            await startRecordingAndStreaming();
          } catch (error) {
            console.error('❌ Failed to start recording and streaming:', error);
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
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
          <Route path="/home" element={<HomePixi />} />
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
