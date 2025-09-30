import { Routes, Route, Navigate, Outlet } from "react-router-dom";
import { useEffect, useRef } from "react";
import Login from "./views/Login";
import Home from "./views/Home";
import Settings from "@/views/Settings.tsx";
import { useAuthenticationStore } from "@/stores/useAuthenticationStore.ts";

const NonAuthenticatedLayout = () => {
  const { isAuthenticated } = useAuthenticationStore();
  return !isAuthenticated ? <Outlet /> : <Navigate to="/home" replace />;
};

const AuthenticatedLayout = () => {
  const { isAuthenticated } = useAuthenticationStore();
  const hasInitialized = useRef(false);

  useEffect(() => {
    if (isAuthenticated && !hasInitialized.current) {
      // Your one-time operation here
      console.log("User authenticated - running initialization");
      // Add your initialization logic: fetch user data, setup analytics, etc.
      hasInitialized.current = true;
    }

    if (!isAuthenticated) {
      hasInitialized.current = false;
    }
  }, [isAuthenticated]);

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
