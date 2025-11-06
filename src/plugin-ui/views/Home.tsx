import { useState } from 'react';
import { Button } from '@ui/button';
import { Settings } from 'lucide-react';
import { useUserSettingsStore } from '@user/stores/useUserSettingsStore.ts';
import { useEffect } from "react";
import { useAuthenticationStore } from "@auth/stores/useAuthenticationStore";
import { useUserConfigQuery } from "@user/api/fetchUserConfig.ts";
import { useCompanionConnection, WebSocketState } from "@companion/api";
import { usePortUpdatesStore } from "@user/stores/usePortUpdatesStore.ts";
import { ReactFlowCanvas } from '@/plugin-ui/features/reactflow/components/ReactFlowCanvas';
import { StatusPanel } from '@status/components/StatusPanel';
import { SettingsPanel } from '@user/components/SettingsPanel';
import { HelpButton } from '@shared/components/HelpButton';
import { useCompanionStore } from '@companion/stores/useCompanionStore';
import { useWebSocketStore } from "@stores/useWebSocketStore.ts";

function Home() {
  const { setUserConfig } = useUserSettingsStore();
  const { setUserId } = useAuthenticationStore();
  const { connect } = useCompanionConnection();
  const { currentPort } = usePortUpdatesStore();
  const { webSocketState } = useCompanionStore();
  const { isConnected, isConnecting } = useWebSocketStore();

  const [statusPanelOpen, setStatusPanelOpen] = useState(false);
  const [settingsPanelOpen, setSettingsPanelOpen] = useState(false);

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

  // Get status label based on connection state
  const getCompanionStatusLabel = () => {
    switch (webSocketState) {
      case WebSocketState.CONNECTED:
        return 'Companion App';
      case WebSocketState.CONNECTING:
        return 'Connecting...';
      case WebSocketState.DISCONNECTED:
        return 'Companion App';
      default:
        return 'Companion App';
    }
  };

  const getBackendStatusLabel = () => {
    if (isConnected) {
      return 'Backend Server';
    } else if (isConnecting) {
      return 'Connecting...';
    } else {
      return 'Backend Server';
    }
  }

  return (
    <div className="relative w-full h-screen overflow-hidden bg-white">
      {/* ReactFlow Canvas - Full Screen */}
      <div className="absolute inset-0">
        <ReactFlowCanvas 
          topRightContent={
            <div className="flex items-center gap-2">
              {/* Companion App Button */}
              <Button
                variant="outline"
                className="bg-white hover:bg-gray-50 text-gray-900 border-gray-300 rounded-full px-4 py-2 font-medium shadow-sm"
                onClick={() => setStatusPanelOpen(!statusPanelOpen)}
              >
                <span className={`inline-block w-2 h-2 rounded-full mr-2 ${
                  webSocketState === WebSocketState.CONNECTED ? 'bg-green-500' : 
                  webSocketState === WebSocketState.CONNECTING ? 'bg-yellow-500' : 
                  'bg-red-500'
                }`} />
                {getCompanionStatusLabel()}
              </Button>

              {/* Backend Button */}
              <Button
                variant="outline"
                className="bg-white hover:bg-gray-50 text-gray-900 border-gray-300 rounded-full px-4 py-2 font-medium shadow-sm"
                onClick={() => setStatusPanelOpen(!statusPanelOpen)}
              >
                <span className={`inline-block w-2 h-2 rounded-full mr-2 ${
                  isConnected ? 'bg-green-500' : 
                  isConnecting ? 'bg-yellow-500' : 
                  'bg-red-500'
                }`} />
                {getBackendStatusLabel()}
              </Button>

              {/* Settings Button */}
              <Button
                variant="outline"
                size="icon"
                className="bg-white hover:bg-gray-50 text-gray-900 border-gray-300 rounded-full shadow-sm"
                onClick={() => setSettingsPanelOpen(!settingsPanelOpen)}
                title="Settings"
              >
                <Settings className="h-5 w-5" />
              </Button>
            </div>
          }
          bottomRightContent={
            <HelpButton onClick={() => console.log('Help clicked')} />
          }
        />
      </div>

      {/* Panels */}
      <StatusPanel 
        isOpen={statusPanelOpen} 
        onClose={() => setStatusPanelOpen(false)} 
      />
      <SettingsPanel 
        isOpen={settingsPanelOpen} 
        onClose={() => setSettingsPanelOpen(false)} 
      />
    </div>
  );
}

export default Home;
