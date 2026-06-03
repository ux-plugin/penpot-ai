import {useEffect, useState} from "react";
import {useAuthenticationStore} from "@/stores/useAuthenticationStore.ts";
import {Button} from "@/components/ui/button";
import {AlertCircle, CheckCircle, LogOut, Play, Square} from "lucide-react";
import {invoke} from "@tauri-apps/api/core";
import {serverStatusListener, ServerStatusPayload} from "@/events/serverStatusListener";

interface UserConfig {
    id: string;
    name?: string;
    username?: string;
    allow_saving_completions: boolean;
}

type ServerStatus = 'starting' | 'success' | 'error' | 'stopped' | 'stopping';

export function Home() {
    const { setUserId, loadFromStorage, setIsAuthenticated } = useAuthenticationStore()
    const [serverStatus, setServerStatus] = useState<ServerStatus>('starting')
    const [error, setError] = useState<string | null>(null)
    const [isActionLoading, setIsActionLoading] = useState(false)
    const [isFetching, setIsFetching] = useState(true)
    const [isError, setIsError] = useState(false)
    const [data, setData] = useState<UserConfig | null>(null)

    // Fetch user config on mount
    useEffect(() => {
        const fetchConfig = async () => {
            try {
                setIsFetching(true)
                const config = await invoke<UserConfig>('fetch_user_config')
                setData(config)
                setIsError(false)
            } catch (err) {
                console.error('Error fetching user config:', err)
                setIsError(true)
            } finally {
                setIsFetching(false)
            }
        }
        fetchConfig()
    }, [])

    // Listen for server status changes from the backend
    useEffect(() => {
        let unlisten: (() => void) | undefined;

        const setupListener = async () => {
            unlisten = await serverStatusListener((payload: ServerStatusPayload) => {
                setServerStatus(payload.status);
                setError(payload.error || null);
            });
        };

        setupListener();

        return () => {
            if (unlisten) {
                unlisten();
            }
        };
    }, []);

    useEffect(() => {
        if (data) {
            setUserId(data.id)
            // Only start server if we're not in an error state
            if (!isError) {
                startServer()
            }
        }
    }, [data, isError])

    useEffect(() => {
        if (isError) {
            const handleLogoutAndRedirect = async () => {
                try {
                    await invoke('logout')
                    setIsAuthenticated(false)
                } catch (error) {
                    console.error('Logout failed:', error)
                }
            }
            handleLogoutAndRedirect()
        }
    }, [isError])

    const startServer = async () => {
        try {
            setError(null)
            await invoke('start_server')
            // Status will be updated via event listener
        } catch (err) {
            console.error('Failed to start server:', err)
            // Error status will be emitted by backend and received via event listener
            // But we also set it here as a fallback
            if (!error) {
                setError(err instanceof Error ? err.message : 'Failed to start application. Please try again.')
            }
        }
    }

    const stopServer = async () => {
        setIsActionLoading(true)
        try {
            setError(null)
            await invoke('stop_server')
            // Status will be updated via event listener
        } catch (err) {
            console.error('Failed to stop server:', err)
            setError(err instanceof Error ? err.message : 'Failed to stop companion')
        } finally {
            setIsActionLoading(false)
        }
    }

    const handleStartServer = async () => {
        setIsActionLoading(true)
        try {
            await startServer()
        } finally {
            setIsActionLoading(false)
        }
    }

    const handleLogout = async () => {
        setIsActionLoading(true)
        try {
            setServerStatus('stopping')
            await invoke('logout')
            await loadFromStorage()
        } catch (err) {
            console.error('Failed to stop server:', err)
            setError(err instanceof Error ? err.message : 'Failed to close application')
        } finally {
            setIsActionLoading(false)
        }
    }

    if (isFetching) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <div className="text-center">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 mx-auto mb-3"></div>
                    <p className="text-sm text-gray-600">Loading...</p>
                </div>
            </div>
        )
    }

    return (
        <div className="flex items-center justify-center min-h-screen bg-gray-50">
            <div className="max-w-sm w-full mx-4">
                <div className="bg-white rounded-lg shadow-md p-6">
                    {/* Status Badge */}
                    <div className="flex items-center justify-center mb-6">
                        {serverStatus === 'starting' && (
                            <div className="flex items-center gap-2">
                                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-600"></div>
                                <span className="text-sm font-medium text-gray-700">Starting...</span>
                            </div>
                        )}
                        {serverStatus === 'success' && (
                            <div className="flex items-center gap-2">
                                <CheckCircle className="h-5 w-5 text-green-600" />
                                <span className="text-sm font-medium text-gray-700">Companion Active</span>
                            </div>
                        )}
                        {serverStatus === 'stopped' && (
                            <div className="flex items-center gap-2">
                                <Square className="h-5 w-5 text-red-600 fill-red-600" />
                                <span className="text-sm font-medium text-gray-700">Companion Stopped</span>
                            </div>
                        )}
                        {serverStatus === 'error' && (
                            <div className="flex items-center gap-2">
                                <AlertCircle className="h-5 w-5 text-red-600" />
                                <span className="text-sm font-medium text-gray-700">Error</span>
                            </div>
                        )}
                        {serverStatus === 'stopping' && (
                            <div className="flex items-center gap-2">
                                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-red-600"></div>
                                <span className="text-sm font-medium text-gray-700">Stopping...</span>
                            </div>
                        )}
                    </div>

                    {/* Informational Message */}
                    <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-md">
                        {serverStatus === 'starting' && (
                            <p className="text-sm text-blue-800">
                                Starting companion... This may take a few moments. The companion enables communication between your design tool and the plugin.
                            </p>
                        )}
                        {serverStatus === 'success' && (
                            <p className="text-sm text-green-800">
                                Companion is active! You can now close this window and return to <strong>Figma</strong> or <strong>Penpot</strong> to use the plugin.
                            </p>
                        )}
                        {serverStatus === 'error' && (
                            <p className="text-sm text-red-800">
                                Companion failed to start. Please try restarting the companion using the button below, or logout and login again to reset your session.
                            </p>
                        )}
                        {serverStatus === 'stopped' && (
                            <p className="text-sm text-gray-800">
                                Companion is stopped. Click 'Start Companion' below to enable plugin functionality.
                            </p>
                        )}
                        {serverStatus === 'stopping' && (
                            <p className="text-sm text-gray-800">
                                Stopping companion...
                            </p>
                        )}
                    </div>

                    {/* Error Message */}
                    {error && (
                        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md">
                            <p className="text-xs text-red-800">{error}</p>
                        </div>
                    )}

                    {/* Action Buttons */}
                    <div className="space-y-2">
                        {/* Start Server Button */}
                        {(serverStatus === 'stopped' || serverStatus === 'error') && (
                            <Button
                                onClick={handleStartServer}
                                disabled={isActionLoading}
                                className="w-full"
                            >
                                {isActionLoading ? (
                                    <>
                                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                                        Starting...
                                    </>
                                ) : (
                                    <>
                                        <Play className="h-4 w-4 mr-2" />
                                        Start Companion
                                    </>
                                )}
                            </Button>
                        )}

                        {/* Stop Server Button */}
                        {serverStatus === 'success' && (
                            <Button
                                onClick={stopServer}
                                disabled={isActionLoading}
                                variant="destructive"
                                className="w-full"
                            >
                                {isActionLoading ? (
                                    <>
                                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                                        Stopping...
                                    </>
                                ) : (
                                    <>
                                        <Square className="h-4 w-4 mr-2" />
                                        Stop Companion
                                    </>
                                )}
                            </Button>
                        )}

                        {/* Logout Button */}
                        <Button
                            onClick={handleLogout}
                            disabled={isActionLoading}
                            variant="ghost"
                            className="w-full"
                        >
                            <LogOut className="h-4 w-4 mr-2" />
                            Logout
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    );
}
