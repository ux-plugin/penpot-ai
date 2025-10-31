import { Button } from '@ui/button';
import { Settings, Mic, Bug } from 'lucide-react';
import { useUserSettingsStore } from '@user/stores/useUserSettingsStore.ts';
import { useNavigate } from "react-router-dom";
import React, { useEffect } from "react";
import { useAuthenticationStore } from "@auth/stores/useAuthenticationStore";
import { useUserConfigQuery } from "@user/api/fetchUserConfig.ts";
import { CompanionAppStatus } from '@companion/components/CompanionAppStatus';
import { BackendServerStatus } from '@status/components/BackendServerStatus';
import { useCompanionConnection } from "@companion/api";
import { MessageCategory, SystemMessageType } from '@shared-core/types/messageTypes';
import { uiMessageDispatcher } from '../messaging/UIMessageDispatcher';
import { usePortUpdatesStore } from "@user/stores/usePortUpdatesStore.ts";

function Home() {
  const { keyboardShortcut, setUserConfig } = useUserSettingsStore();
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
      {/* Header */}
      <div className="flex justify-between items-center px-6 py-4">
        <div className="flex items-center space-x-2">
          <span className="w-2 h-2 bg-black rounded-full"></span>
          <h1 className="text-lg font-semibold">AI Voice Assistant</h1>
        </div>
        <div className="flex items-center space-x-2">
          <BackendServerStatus variant="icon" />
          <CompanionAppStatus variant="icon" />
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
          <Button variant="ghost" size="icon" className="text-gray-800 hover:bg-gray-100" onClick={() => navigate('/settings')}>
            <Settings className="h-5 w-5" />
          </Button>
        </div>
      </div>

      {/* Main content */}
      <div className="flex flex-col items-center justify-center flex-1">
        <Button className="w-32 h-32 rounded-full bg-black flex items-center justify-center shadow-lg" size="icon">
          <Mic className="h-16 w-16 text-white" />
        </Button>
        <p className="mt-4 text-lg font-medium">Ready</p>

        {/* Shortcut indication */}
        <div className="mt-8 flex items-center text-sm text-gray-600">
          <span className="mr-2">Press</span>
          {keyboardShortcut.map((key, index) => (
            <React.Fragment key={index}>
              <kbd key={index} className="px-2 py-1 bg-gray-200 rounded-md shadow-sm border border-gray-300 text-gray-800 font-sans">
                {key}
              </kbd>
              {index < keyboardShortcut.length - 1 && <span className="mx-0.5">+</span>}
            </React.Fragment>
          ))}
          <span className="ml-2">to record</span>
        </div>
        
        {/* Companion App Status */}
        <div className="mt-8 w-full max-w-md space-y-3">
          <BackendServerStatus variant="full" />
          <CompanionAppStatus variant="full" />
        </div>
      </div>
    </div>
  );
}

export default Home;
