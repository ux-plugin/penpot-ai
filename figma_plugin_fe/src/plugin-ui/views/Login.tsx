import { useCallback } from "react";
import { Button } from "@ui/button";
import { Loader2 } from "lucide-react";
import { useAuth0LoginQuery } from "@/plugin-ui/api/auth/loginAuth0.ts";
import { useAuthenticationStore } from "../stores/useAuthenticationStore.ts";
import { showErrorToast } from "@/plugin-ui/utils/showErrorToast.ts";

function Login() {
  const { setAuthenticated, setAccessToken, setRefreshToken, setAuthProvider } = useAuthenticationStore();

  const {
    isFetching: isPending,
    refetch,
  } = useAuth0LoginQuery({ enabled: false });

  const handleLogin = useCallback(async () => {
    try {
      const result = await refetch();

      if (result.error) {
        return;
      }

      if (!result.data?.accessToken || !result.data?.refreshToken) {
        showErrorToast("Malformed response from the server.");
        return;
      }

      setAccessToken(result.data.accessToken);
      setRefreshToken(result.data.refreshToken, result.data.refreshTokenExpiresAt);
      setAuthenticated(true);
      setAuthProvider("AUTH0");
    } catch (err: unknown) {
      showErrorToast(err, "An unexpected error occurred.");
    }
  }, [refetch, setAccessToken, setRefreshToken, setAuthProvider, setAuthenticated]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4">
      <div className="w-64">
        <Button
          onClick={handleLogin}
          variant="outline"
          size="lg"
          className="w-full"
          disabled={isPending}
        >
          {isPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Please wait
            </>
          ) : (
            "Sign in"
          )}
        </Button>
      </div>
    </div>
  );
}

export default Login;
