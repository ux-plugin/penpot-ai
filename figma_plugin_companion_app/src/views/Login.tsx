import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { useAuthenticationStore } from "@/stores/useAuthenticationStore";
import { showErrorToast } from "@/utils/showErrorToast";
import { invoke } from "@tauri-apps/api/core";

interface LoginAuthData {
    access_token: string;
    refresh_token: string;
    refresh_token_expires_at: string;
}

export const Login = () => {
    const { setAccessToken, setRefreshToken, setIsAuthenticated, setRefreshTokenExpiresAt } = useAuthenticationStore();

    const [isLoading, setIsLoading] = useState(false);

    const handleLogin = useCallback(async () => {
        setIsLoading(true);
        try {
            const result = await invoke<LoginAuthData>('login_with_auth0');

            if (!result.access_token || !result.refresh_token) {
                showErrorToast("Malformed response from the server.");
                return;
            }

            setAccessToken(result.access_token);
            setRefreshToken(result.refresh_token);
            setIsAuthenticated(true);
            setRefreshTokenExpiresAt(result.refresh_token_expires_at);

        } catch (err: unknown) {
            showErrorToast(err, "An unexpected error occurred.");
        } finally {
            setIsLoading(false);
        }
    }, [setAccessToken, setRefreshToken, setIsAuthenticated]);

    return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-4">
            <div className="w-64">
                <Button
                    onClick={handleLogin}
                    variant="outline"
                    size="lg"
                    className="w-full"
                    disabled={isLoading}
                >
                    {isLoading ? (
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
