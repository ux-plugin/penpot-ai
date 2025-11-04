import { Button } from '@ui/button';
import { Settings, Bug } from 'lucide-react';
import { useUserSettingsStore } from '@user/stores/useUserSettingsStore.ts';
import { useNavigate } from "react-router-dom";
import { useEffect } from "react";
import { useAuthenticationStore } from "@auth/stores/useAuthenticationStore";
import { useUserConfigQuery } from "@user/api/fetchUserConfig.ts";
import { CompanionAppStatus } from '@companion/components/CompanionAppStatus';
import { BackendServerStatus } from '@status/components/BackendServerStatus';
import { useCompanionConnection } from "@companion/api";
import { MessageCategory, SystemMessageType } from '@shared-core/types/messageTypes';
import { uiMessageDispatcher } from '../messaging/UIMessageDispatcher';
import { usePortUpdatesStore } from "@user/stores/usePortUpdatesStore.ts";

function Home() {
  const { setUserConfig } = useUserSettingsStore();
  const { setUserId } = useAuthenticationStore();
  const navigate = useNavigate();
  const { connect } = useCompanionConnection();
  const { currentPort } = usePortUpdatesStore();

  const { data: userConfig } = useUserConfigQuery({ enabled: true });

  // Load user configuration
  useEffect(() => {
    if (userConfig) {
      setUserId(userConfig.id);
      setUserConfig(userConfig);
    }
  }, [userConfig, setUserConfig, setUserId]);

  useEffect(() => {
    if (currentPort) {
      connect().then(() => {
        console.log("Reconnected to companion app");
      }).catch((error) => {
        console.error('Reconnection failed:', error);
      });
    }
  }, [currentPort]);

  // Function to test worker communication (development only)
  const handleWorkerTest = async () => {
    const testMessage = 'Hello from UI button!';
    
    console.log('[UI] Sending worker test message:', testMessage);
    
    try {
      const result = await uiMessageDispatcher.sendRequest({
        category: MessageCategory.SYSTEM,
        type: SystemMessageType.WORKER_TEST,
        payload: {
          message: testMessage,
          testData: { timestamp: Date.now(), source: 'Home.tsx' }
        }
      });
      
      console.log('[UI] Worker test response received:', result);
      console.log('[UI] Response details:', {
        received: result.received,
        echoed: result.echoed,
        processedBy: result.processedBy
      });
    } catch (error) {
      console.error('[UI] Worker test failed:', error);
    }
  };

  return (
    <div className="min-h-screen bg-white text-black flex flex-col">
      {/* Top-right section with state indicators and settings icon */}
      <div className="absolute top-4 right-4 flex items-center space-x-2">
        {/* Companion app state badge */}
        <CompanionAppStatus variant="badge" />
        
        {/* Backend state badge */}
        <BackendServerStatus variant="badge" />
        
        {/* Debug button (dev only) */}
        {import.meta.env.DEV && (
          <Button 
            variant="ghost" 
            size="icon" 
            className="text-blue-600 hover:bg-blue-50" 
            onClick={handleWorkerTest}
            title="Test Worker Communication"
          >
            <Bug className="h-5 w-5" />
          </Button>
        )}
        
        {/* Settings icon */}
        <Button 
          variant="ghost" 
          size="icon" 
          className="text-gray-800 hover:bg-gray-100" 
          onClick={() => navigate('/settings')}
          title="Settings"
        >
          <Settings className="h-5 w-5" />
        </Button>
      </div>

      {/* React Flow Area - Central content */}
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="w-full h-full border-2 border-dashed border-gray-300 rounded-lg flex items-center justify-center">
          <p className="text-gray-500 text-lg">react flow area</p>
        </div>
      </div>
    </div>
  );
}

export default Home;
