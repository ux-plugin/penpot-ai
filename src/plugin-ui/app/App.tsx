import { Routes, Route, Navigate, Outlet } from "react-router-dom";
import { useEffect, useRef } from "react";
import Login from "@auth/views/Login";
import Home from "@views/Home";
import Settings from "@user/views/Settings";
import { useAuthenticationStore } from "@auth/stores/useAuthenticationStore";
import { usePortUpdatesStore } from "@user/stores/usePortUpdatesStore";
import { connectionManager } from "@companion/api";

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
