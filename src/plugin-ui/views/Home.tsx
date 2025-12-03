import { useState, useEffect } from 'react';
import { Button } from '@ui/button';
import {
  Settings,
  Minimize2,
  Maximize2,
  MessageSquare,
} from "lucide-react";
import { useUserSettingsStore } from '@/plugin-ui/stores/useUserSettingsStore.ts';
import { useAuthenticationStore } from "@/plugin-ui/stores/useAuthenticationStore.ts";
import { useUserConfigQuery } from "@/plugin-ui/api/user/fetchUserConfig.ts";
import { useCompanionConnection } from "@/plugin-ui/api/companion";
import { usePortUpdatesStore } from "@/plugin-ui/stores/usePortUpdatesStore.ts";
import { ReactFlowCanvas } from '@/plugin-ui/components/completions/ReactFlowCanvas.tsx';
import { StatusPanel } from '@/plugin-ui/components/status/StatusPanel';
import { SettingsPanel } from '@/plugin-ui/components/user/SettingsPanel';
import { ConversationPanel } from '@/plugin-ui/components/completions/ConversationPanel';
import { uiMessageDispatcher } from '@/plugin-ui/UIMessageDispatcher.ts';
import { MessageCategory, SystemMessageType, ResizeRequest, ExtractResultType, ResizeResponse } from '@/shared/types/messageTypes';
import { BackendServerStatus } from '@/plugin-ui/components/status/BackendServerStatus';
import { CompanionAppStatus } from '@/plugin-ui/components/CompanionAppStatus.tsx';

function Home() {
  const { setUserConfig } = useUserSettingsStore();
  const { setUserId } = useAuthenticationStore();
  const { connect } = useCompanionConnection();
  const { currentPort } = usePortUpdatesStore();

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


  const handleMinimizeWindow = async () => {
    // Minimize to the minimum possible size
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
    <div className="relative w-full h-screen bg-white overflow-hidden min-w-[650px] min-h-[400px]">
      {/* ReactFlow Canvas - Full Screen */}
      <div className="absolute inset-0">
        <ReactFlowCanvas
          topRightContent={
            <div className="flex items-center gap-2">
              {/* Companion App Status */}
              <div onClick={() => setStatusPanelOpen(!statusPanelOpen)}>
                <CompanionAppStatus variant="icon" className="bg-white border border-gray-300 shadow-sm" />
              </div>

              {/* Backend Server Status */}
              <div onClick={() => setStatusPanelOpen(!statusPanelOpen)}>
                <BackendServerStatus variant="icon" className="bg-white border border-gray-300 shadow-sm" />
              </div>

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
      <ConversationPanel
        isOpen={conversationPanelOpen}
        onClose={() => setConversationPanelOpen(false)}
      />
    </div>
  );
}

export default Home;
