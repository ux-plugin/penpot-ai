import {useUserConfigQuery} from "@/api/user/fetchUserConfig.ts";
import {useEffect, useState} from "react";
import {useAuthenticationStore} from "@/stores/useAuthenticationStore.ts";
import {Button} from "@/components/ui/button";
import {AlertCircle, CheckCircle, RotateCcw, LogOut} from "lucide-react";
import {invoke} from "@tauri-apps/api/core";

type ServerStatus = 'starting' | 'success' | 'error' | 'stopping';

export function Home() {
    const { data, isFetching, isError } = useUserConfigQuery({
        enabled: true,
    })
    const { setUserId, loadFromStorage } = useAuthenticationStore()
    const [serverStatus, setServerStatus] = useState<ServerStatus>('starting')
    const [error, setError] = useState<string | null>(null)
    const [isActionLoading, setIsActionLoading] = useState(false)

    useEffect(() => {
        if (data) {
            setUserId(data.id)
            startServer()
        }
    }, [data])

    useEffect(() => {
        if(isError){
            invoke('logout').catch(console.error)
        }
    }, [isError])

    const startServer = async () => {
        try {
            setServerStatus('starting')
            setError(null)
            await invoke('start_server')
            setServerStatus('success')
        } catch (err) {
            console.error('Failed to start server:', err)
            setServerStatus('error')
            setError(err instanceof Error ? err.message : 'Failed to start application. Please try again.')
        }
    }

    const handleReload = async () => {
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
                    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-gray-900 mx-auto mb-4"></div>
                    <p className="text-lg text-gray-600">Loading user configuration...</p>
                </div>
            </div>
        )
    }

    return (
        <div className="flex items-center justify-center min-h-screen bg-gray-50">
            <div className="max-w-md w-full mx-4">
                <div className="bg-white rounded-lg shadow-lg p-8 text-center">
                    {/* Status Icon and Message */}
                    {serverStatus === 'starting' && (
                        <div className="mb-6">
                            <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-blue-600 mx-auto mb-4"></div>
                            <h2 className="text-xl font-semibold text-gray-800 mb-2">Starting Application</h2>
                            <p className="text-gray-600">Please wait while we initialize...</p>
                        </div>
                    )}

                    {serverStatus === 'success' && (
                        <div className="mb-6">
                            <CheckCircle className="h-16 w-16 text-green-600 mx-auto mb-4" />
                            <h2 className="text-xl font-semibold text-gray-800 mb-2">Ready to Use</h2>
                            <p className="text-gray-600">Application is ready. You can close this window or logout when finished.</p>
                        </div>
                    )}

                    {serverStatus === 'error' && (
                        <div className="mb-6">
                            <AlertCircle className="h-16 w-16 text-red-600 mx-auto mb-4" />
                            <h2 className="text-xl font-semibold text-gray-800 mb-2">Startup Failed</h2>
                            <p className="text-gray-600 mb-4">The application failed to start properly. Please try reloading.</p>
                            {error && (
                                <div className="bg-red-50 border border-red-200 rounded-md p-3 text-left">
                                    <p className="text-sm text-red-800 font-medium">Error Details:</p>
                                    <p className="text-sm text-red-700 mt-1">{error}</p>
                                </div>
                            )}
                        </div>
                    )}

                    {serverStatus === 'stopping' && (
                        <div className="mb-6">
                            <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-red-600 mx-auto mb-4"></div>
                            <h2 className="text-xl font-semibold text-gray-800 mb-2">Shutting Down</h2>
                            <p className="text-gray-600">Closing application...</p>
                        </div>
                    )}

                    {/* Action Buttons */}
                    <div className="space-y-3">
                        {serverStatus === 'error' && (
                            <Button
                                onClick={handleReload}
                                disabled={isActionLoading}
                                className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-md transition-colors"
                            >
                                {isActionLoading ? (
                                    <>
                                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                                        Reloading...
                                    </>
                                ) : (
                                    <>
                                        <RotateCcw className="h-4 w-4 mr-2" />
                                        Reload App
                                    </>
                                )}
                            </Button>
                        )}

                        {serverStatus === 'success' && (
                            <Button
                                onClick={handleLogout}
                                disabled={isActionLoading}
                                variant="destructive"
                                className="w-full font-medium py-2 px-4 rounded-md transition-colors"
                            >
                                {isActionLoading ? (
                                    <>
                                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                                        Logging out...
                                    </>
                                ) : (
                                    <>
                                        <LogOut className="h-4 w-4 mr-2" />
                                        Logout
                                    </>
                                )}
                            </Button>
                        )}
                    </div>

                    {/* Additional Info */}
                    {serverStatus === 'success' && (
                        <div className="mt-6 pt-4 border-t border-gray-200">
                            <p className="text-sm text-gray-500">
                                The application is now running in the background. 
                                This window can be safely closed.
                            </p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}