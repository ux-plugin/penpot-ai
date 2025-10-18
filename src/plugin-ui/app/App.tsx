import { Routes, Route, Navigate, Outlet } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import Login from "@auth/views/Login";
import Home from "@views/Home";
import Settings from "@user/views/Settings";
import { useAuthenticationStore } from "@auth/stores/useAuthenticationStore";
import { usePortUpdatesStore } from "@user/stores/usePortUpdatesStore";
import { connectionManager } from "@companion/api";
import { useCompletionsWebSocket } from "@completions/api";

const NonAuthenticatedLayout = () => {
  const { isAuthenticated } = useAuthenticationStore();
  return !isAuthenticated ? <Outlet /> : <Navigate to="/home" replace />;
};

const AuthenticatedLayout = () => {
  const { isAuthenticated } = useAuthenticationStore();
  const { currentPort } = usePortUpdatesStore();
  const hasInitialized = useRef(false);
  const prevPortRef = useRef<number | null>(null);

  // Initialize port listener when user authenticates
  useEffect(() => {
    if (isAuthenticated && !hasInitialized.current) {
      console.log("User authenticated - running initialization");

      // Start port updates listener
      console.log("Starting port updates listener...");
      const { connect } = usePortUpdatesStore.getState();
      connect();
      
      hasInitialized.current = true;
    }

    if (!isAuthenticated && hasInitialized.current) {
      console.log("User logged out - cleaning up");
      const { disconnect } = usePortUpdatesStore.getState();
      disconnect();
      hasInitialized.current = false;
      prevPortRef.current = null;
    }
  }, [isAuthenticated]);

  // Handle port changes (only when authenticated)
  useEffect(() => {
    if (isAuthenticated && currentPort && currentPort !== prevPortRef.current) {
      console.log(`Port changed to ${currentPort}, triggering reconnection...`);
      connectionManager.onPortUpdate(currentPort).catch((error) => {
        console.error('Failed to reconnect after port update:', error);
      });
      prevPortRef.current = currentPort;
    }
  }, [currentPort, isAuthenticated]);

  return isAuthenticated ? <Outlet /> : <Navigate to="/login" replace />;
};

function App() {
  const { isAuthenticated } = useAuthenticationStore();
  const [acknowledgementsCount, setAcknowledgementsCount] = useState(0);

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
      setAcknowledgementsCount(0);
    },
    
    onWebSocketClose: () => {
      console.log('🔌 WebSocket closed');
    },
    
    onWebSocketError: (event) => {
      console.error('❌ WebSocket error:', event);
    },
    
    onAcknowledgment: (message) => {
      console.log('📨 Backend acknowledged chunk:', message);
      setAcknowledgementsCount((prev) => prev + 1);
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
          console.log(`✅ Stopped. Total chunks sent: ${acknowledgementsCount}`);
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
  }, [isRecording, startRecordingAndStreaming, stopRecordingAndStreaming, acknowledgementsCount]);

  return (
    <Routes>
      <Route element={<NonAuthenticatedLayout />}>
        <Route path="/login" element={<Login />} />
      </Route>

      <Route element={<AuthenticatedLayout />}>
        <Route path="/home" element={<Home />} />
        <Route path="/settings" element={<Settings />} />
      </Route>

      <Route
        path="*"
        element={isAuthenticated ? <Navigate to="/home" replace /> : <Navigate to="/login" replace />}
      />
    </Routes>
  );
}

export default App;
