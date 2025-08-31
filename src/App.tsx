import { Routes, Route, Navigate, Outlet } from "react-router-dom";
import Login from "./views/Login";
import Home from "./views/Home";
import { useAuthenticationStore } from "@/stores/useAuthenticationStore.ts";
import Settings from "@/views/Settings.tsx";

const AuthenticatedRoutes = () => {
  const { isAuthenticated } = useAuthenticationStore();

  return isAuthenticated ? <Outlet /> : <Navigate to="/login" replace />;
};

const NonAuthenticatedRoutes = () => {
  const { isAuthenticated } = useAuthenticationStore();

  return !isAuthenticated ? <Outlet /> : <Navigate to="/home" replace />;
};


function App() {
  const { isAuthenticated } = useAuthenticationStore();

  return (
    <Routes>
      <Route element={<NonAuthenticatedRoutes />}>
        <Route path="/login" element={<Login />} />
      </Route>
      <Route element={<AuthenticatedRoutes />}>
        <Route path="/home" element={<Home />} />
        <Route path="/settings" element={<Settings />}/>
      </Route>
      <Route
        path="*"
        element={isAuthenticated ? <Navigate to="/home" replace /> : <Navigate to="/login" replace />}
      />

    </Routes>
  );
}

export default App;
