import { useCallback } from "react";
import { Button } from "@ui/button";
import { FigmaIcon } from "@assets/icons/FigmaIcon.tsx";
import { GitHubIcon } from "@assets/icons/GithubIcon.tsx";
import { useGithubLoginQuery } from "@/plugin-ui/api/auth/loginGithub.ts";
import { useFigmaLoginQuery } from "@/plugin-ui/api/auth/loginFigma.ts";
import { Loader2 } from "lucide-react";
import { useAuthenticationStore } from "../stores/useAuthenticationStore.ts";
import { useUserSettingsStore } from "@/plugin-ui/stores/useUserSettingsStore.ts";
import { showErrorToast } from "@/plugin-ui/utils/showErrorToast.ts";

function Login() {
  const { setAuthenticated, setAccessToken, setRefreshToken, setAuthProvider, setUserId } = useAuthenticationStore();
  const { setUserConfig } = useUserSettingsStore();

  // Keep queries disabled so we trigger them manually with refetch()
  const {
    isFetching: githubIsPending,
    refetch: refetchGithub,
  } = useGithubLoginQuery({ enabled: false });

  const {
    isFetching: figmaIsPending,
    refetch: refetchFigma,
  } = useFigmaLoginQuery({ enabled: false });

  // Individual loading states for each provider
  const isAnyLoading = githubIsPending || figmaIsPending;

  const handleFigmaLogin = useCallback(async () => {
    try {
      const result = await refetchFigma();

      if (result.error) {
        // Global query error will be handled by queryClient onError -> toast
        return;
      }

      if (!result.data?.accessToken || !result.data?.accessToken) {
        showErrorToast("Malformed response from the server.");
        return;
      }

      setAccessToken(result.data.accessToken);
      setRefreshToken(result.data.refreshToken, result.data.refreshTokenExpiresAt);
      setAuthenticated(true); // Set authenticated immediately
      setAuthProvider("FIGMA");

    } catch (err: unknown) {
      // Fallback for unexpected exceptions
      showErrorToast(err, "An unexpected error occurred.");
    }
  }, [refetchFigma, setAccessToken, setRefreshToken, setAuthProvider, setAuthenticated, setUserId, setUserConfig]);

  const handleGitHubLogin = useCallback(async () => {
    try {
      const result = await refetchGithub();

      if (result.error) {
        // Global query error will be handled by queryClient onError -> toast
        return;
      }

      if (!result.data?.accessToken || !result.data?.accessToken) {
        showErrorToast("Malformed response from the server.");
        return;
      }

      setAccessToken(result.data.accessToken);
      setRefreshToken(result.data.refreshToken, result.data.refreshTokenExpiresAt);
      setAuthenticated(true); // Set authenticated immediately
      setAuthProvider("GITHUB");

    } catch (err: unknown) {
      // Fallback for unexpected exceptions
      showErrorToast(err, "An unexpected error occurred.");
    }
  }, [refetchGithub, setAccessToken, setRefreshToken, setAuthProvider, setAuthenticated, setUserId, setUserConfig]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4">
      <div className="w-64">
        <div className="flex flex-col gap-3">
          <Button
            onClick={handleFigmaLogin}
            variant="outline"
            size="lg"
            className="w-full"
            disabled={isAnyLoading}
          >
            {figmaIsPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Please wait
              </>
            ) : (
              <>
                <FigmaIcon />
                Login with Figma
              </>
            )}
          </Button>

          <Button
            onClick={handleGitHubLogin}
            variant="outline"
            size="lg"
            className="w-full"
            disabled={isAnyLoading}
          >
            {githubIsPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Please wait
              </>
            ) : (
              <>
                <GitHubIcon />
                Login with GitHub
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default Login;
