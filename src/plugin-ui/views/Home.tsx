import { useState } from 'react';
import { Button } from '@ui/button';
import { Settings, Minimize2, Maximize2, MessageSquare } from 'lucide-react';
import { useUserSettingsStore } from '@user/stores/useUserSettingsStore.ts';
import { useEffect } from "react";
import { useAuthenticationStore } from "@auth/stores/useAuthenticationStore";
import { useUserConfigQuery } from "@user/api/fetchUserConfig.ts";
import { useCompanionConnection, WebSocketState } from "@companion/api";
import { usePortUpdatesStore } from "@user/stores/usePortUpdatesStore.ts";
import { ReactFlowCanvas } from '@/plugin-ui/features/reactflow/components/ReactFlowCanvas';
import { StatusPanel } from '@status/components/StatusPanel';
import { SettingsPanel } from '@user/components/SettingsPanel';
import { useCompanionStore } from '@companion/stores/useCompanionStore';
import { useWebSocketStore } from "@stores/useWebSocketStore.ts";
import { ConversationPanel } from '@completions/components/ConversationHistory';
import { uiMessageDispatcher } from '@messaging/UIMessageDispatcher';
import { MessageCategory, SystemMessageType, ResizeRequest, ExtractResultType, ResizeResponse } from '@shared-core/types/messageTypes';

function Home() {
  const { setUserConfig } = useUserSettingsStore();
  const { setUserId } = useAuthenticationStore();
  const { connect } = useCompanionConnection();
  const { currentPort } = usePortUpdatesStore();
  const { webSocketState } = useCompanionStore();
  const { isConnected, isConnecting } = useWebSocketStore();

  const [statusPanelOpen, setStatusPanelOpen] = useState(false);
  const [settingsPanelOpen, setSettingsPanelOpen] = useState(false);
  const [conversationPanelOpen, setConversationPanelOpen] = useState(false);

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

  const handleMinimizeWindow = async () => {
    // Minimize to minimum possible size
    try {
      await uiMessageDispatcher.sendRequest<
        Omit<ResizeRequest, 'id' | 'timestamp' | 'source'>,
        ExtractResultType<ResizeResponse>
      >({
        category: MessageCategory.SYSTEM,
        type: SystemMessageType.RESIZE,
        payload: {
          width: 24,
          height: 24
        }
      });
      console.log('Window minimized to 24x24');
    } catch (error) {
      console.error('Failed to minimize window:', error);
    }
  };

  const handleMaximizeWindow = async () => {
    // Maximize to fill available viewport space
    // Figma will automatically constrain to viewport bounds
    try {
      await uiMessageDispatcher.sendRequest<
        Omit<ResizeRequest, 'id' | 'timestamp' | 'source'>,
        ExtractResultType<ResizeResponse>
      >({
        category: MessageCategory.SYSTEM,
        type: SystemMessageType.RESIZE,
        payload: {
          width: 10000,
          height: 10000
        }
      });
      console.log('Window maximized to fill viewport');
    } catch (error) {
      console.error('Failed to maximize window:', error);
    }
  };

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

              {/* Maximize Button */}
              <Button
                variant="outline"
                size="icon"
                className="bg-white hover:bg-gray-50 text-gray-900 border-gray-300 rounded-full shadow-sm"
                onClick={handleMaximizeWindow}
                title="Maximize Window"
              >
                <Maximize2 className="h-5 w-5" />
              </Button>

              {/* Minimize Button */}
              <Button
                variant="outline"
                size="icon"
                className="bg-white hover:bg-gray-50 text-gray-900 border-gray-300 rounded-full shadow-sm"
                onClick={handleMinimizeWindow}
                title="Minimize Window"
              >
                <Minimize2 className="h-5 w-5" />
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
          topLeftContent={
            <div className="flex items-center gap-2">
              {/* Conversation Button */}
              <Button
                variant="outline"
                size="icon"
                className="bg-white hover:bg-gray-50 text-gray-900 border-gray-300 rounded-full shadow-sm"
                onClick={() => setConversationPanelOpen(!conversationPanelOpen)}
                title="Conversations"
              >
                <MessageSquare className="h-5 w-5" />
              </Button>
            </div>
          }
        />
      </div>
      <StatusPanel
        isOpen={statusPanelOpen}
        onClose={() => setStatusPanelOpen(false)}
      />
      <SettingsPanel
        isOpen={settingsPanelOpen}
        onClose={() => setSettingsPanelOpen(false)}
      />
      {conversationPanelOpen && (
        <div className="absolute top-16 left-4 z-50">
          <ConversationPanel onClose={() => setConversationPanelOpen(false)} />
        </div>
      )}
    </div>
  );
}

export default Home;
