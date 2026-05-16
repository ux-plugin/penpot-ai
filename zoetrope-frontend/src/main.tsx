import { Auth0Provider } from "@auth0/auth0-react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { auth0Config } from "./auth/config";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Auth0Provider
      domain={auth0Config.domain ?? ""}
      clientId={auth0Config.clientId ?? ""}
      authorizationParams={{
        redirect_uri: window.location.origin,
        audience: auth0Config.audience,
      }}
      // Persist the session across reloads via refresh tokens in localStorage.
      // For higher-security setups, switch to `cacheLocation: "memory"` and
      // use silent auth (`useRefreshTokens` still works without persistence).
      cacheLocation="localstorage"
      useRefreshTokens
    >
      <App />
    </Auth0Provider>
  </StrictMode>,
);
