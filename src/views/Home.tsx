import {useUserConfigQuery} from "@/api/user/fetchUserConfig.ts";
import {useEffect} from "react";
import {useAuthenticationStore} from "@/stores/useAuthenticationStore.ts";

export function Home() {
    const { data, isFetching } = useUserConfigQuery({enabled: true})
    const { setUserId } = useAuthenticationStore()
    useEffect(() => {
        if (data) {
            setUserId(data.id)
        }
    }, [data])
    return (
        <>
            {isFetching ? (
                <div className="flex items-center justify-center min-h-screen">
                    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-gray-900"></div>
                </div>
            ) : (
                <div className="flex items-center justify-center min-h-screen">
                    <p className="text-lg">You can close this window now.</p>
                </div>
            )}
        </>
    );
}