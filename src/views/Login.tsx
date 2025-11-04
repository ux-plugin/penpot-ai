import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { FigmaIcon } from "@/assets/FigmaIcon.tsx";
import { GitHubIcon } from "@/assets/GithubIcon.tsx";
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

    const [figmaLoading, setFigmaLoading] = useState(false);
    const [githubLoading, setGithubLoading] = useState(false);

    // Individual loading states for each provider
    const isAnyLoading = githubLoading || figmaLoading;

    const handleFigmaLogin = useCallback(async () => {
        setFigmaLoading(true);
        try {
            const result = await invoke<LoginAuthData>('login_with_figma');

            if (!result.access_token || !result.refresh_token) {
                showErrorToast("Malformed response from the server.");
                return;
            }

            setAccessToken(result.access_token);
            setRefreshToken(result.refresh_token);
            setIsAuthenticated(true);
            setRefreshTokenExpiresAt(result.refresh_token_expires_at);

        } catch (err: unknown) {
            // Fallback for unexpected exceptions
            showErrorToast(err, "An unexpected error occurred.");
        } finally {
            setFigmaLoading(false);
        }
    }, [setAccessToken, setRefreshToken, setIsAuthenticated, setRefreshTokenExpiresAt]);

    const handleGitHubLogin = useCallback(async () => {
        setGithubLoading(true);
        try {
            const result = await invoke<LoginAuthData>('login_with_github');

            if (!result.access_token || !result.refresh_token) {
                showErrorToast("Malformed response from the server.");
                return;
            }

            setAccessToken(result.access_token);
            setRefreshToken(result.refresh_token);
            setRefreshTokenExpiresAt(result.refresh_token_expires_at);
            setIsAuthenticated(true);

        } catch (err: unknown) {
            // Fallback for unexpected exceptions
            showErrorToast(err, "An unexpected error occurred.");
        } finally {
            setGithubLoading(false);
        }
    }, [setAccessToken, setRefreshToken, setIsAuthenticated, setRefreshTokenExpiresAt]);

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
                        {figmaLoading ? (
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
                        {githubLoading ? (
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

