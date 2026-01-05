import { useState, useEffect } from 'react';
import { Button } from '@ui/button';
import {
  Settings,
  Minimize2,
  Maximize2,
  MessageSquare,
  Bug,
} from "lucide-react";
import { useUserSettingsStore } from '@/plugin-ui/stores/useUserSettingsStore.ts';
import { useAuthenticationStore } from "@/plugin-ui/stores/useAuthenticationStore.ts";
import { useUserConfigQuery } from "@/plugin-ui/api/user/fetchUserConfig.ts";
import { useCompanionConnection } from "@/plugin-ui/api/companion";
import { usePortUpdatesStore } from "@/plugin-ui/stores/usePortUpdatesStore.ts";
import { PixiCanvas } from '@/plugin-ui/components/completions/PixiCanvas.tsx';
import { StatusPanel } from '@/plugin-ui/components/status/StatusPanel';
import { SettingsPanel } from '@/plugin-ui/components/user/SettingsPanel';
import { ConversationPanel } from '@/plugin-ui/components/completions/ConversationPanel';
import { NodeDebugPanel } from '@/plugin-ui/components/nodes/NodeDebugPanel';
import { uiMessageDispatcher } from '@/plugin-ui/UIMessageDispatcher.ts';
import { MessageCategory, SystemMessageType, ResizeRequest, ExtractResultType, ResizeResponse, GetAllNodesResponse } from '@/shared/types/messageTypes';
import { BackendServerStatus } from '@/plugin-ui/components/status/BackendServerStatus';
import { CompanionAppStatus } from '@/plugin-ui/components/CompanionAppStatus.tsx';
import { DesignNode } from "@shared-types/types.ts";
import { parseSVGToProps } from "@utils/figmaStyleConversions.tsx";

function HomePixi() {
  const { setUserConfig } = useUserSettingsStore();
  const { setUserId } = useAuthenticationStore();
  const { connect } = useCompanionConnection();
  const { currentPort } = usePortUpdatesStore();

  const [statusPanelOpen, setStatusPanelOpen] = useState(false);
  const [settingsPanelOpen, setSettingsPanelOpen] = useState(false);
  const [conversationPanelOpen, setConversationPanelOpen] = useState(false);
  const [debugPanelOpen, setDebugPanelOpen] = useState(false);
  const [nodes, setNodes] = useState<DesignNode[]>([]);

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
      connect().catch((error) => {
        console.error('Reconnection failed:', error);
      });
    }
  }, [currentPort, connect]);

  // Load nodes when debug panel is opened
  useEffect(() => {
    const loadNodes = async () => {
      if (debugPanelOpen && import.meta.env.VITE_ENABLE_BUILD_DEBUG === "true") {
        try {
          const result = await uiMessageDispatcher.sendRequest<
            Omit<any, 'id' | 'timestamp' | 'source'>,
            ExtractResultType<GetAllNodesResponse>
          >({
            category: MessageCategory.SYSTEM,
            type: SystemMessageType.GET_ALL_NODES,
            payload: {}
          });
          const processedNodes = result.nodes.map((node) => {
            if (node.type === "textNode") {
              console.log("the textNode: ", node);
              node.data.svgElement =
                parseSVGToProps(node.data.svg) ?? undefined;
              console.log("the textNode with svgElement: ", node);
            }
            return node;
          });
          console.log("the nodes: ", processedNodes);
          setNodes(processedNodes);
        } catch (error) {
          console.error('[HomePixi] Failed to load nodes for debug panel:', error);
        }
      }
    };
    loadNodes();
  }, [debugPanelOpen]);

  const handleMinimizeWindow = async () => {
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
    } catch (error) {
      console.error('Failed to minimize window:', error);
    }
  };

  const handleMaximizeWindow = async () => {
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
    } catch (error) {
      console.error('Failed to maximize window:', error);
    }
  };


  return (
    <div className="relative w-full h-screen bg-white overflow-hidden min-w-[650px] min-h-[400px]">
      {/* PixiJS Canvas - Full Screen */}
      <div className="absolute inset-0">
        <PixiCanvas
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

              {/* Debug Button - only shown when VITE_ENABLE_BUILD_DEBUG is true */}
              {import.meta.env.VITE_ENABLE_BUILD_DEBUG === "true" && (
                <Button
                  variant="outline"
                  size="icon"
                  className="bg-white hover:bg-gray-50 text-gray-900 border-gray-300 rounded-full shadow-sm"
                  onClick={() => setDebugPanelOpen(!debugPanelOpen)}
                  title="Debug Panel"
                >
                  <Bug className="h-5 w-5" />
                </Button>
              )}
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

      {/* PixiJS indicator badge */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10">
        <div className="bg-green-100 text-green-700 px-3 py-1 rounded-full text-xs font-medium border border-green-200 shadow-sm">
          PixiJS (GPU Accelerated)
        </div>
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
      {/* Debug Panel - only shown when VITE_ENABLE_BUILD_DEBUG is true */}
      {import.meta.env.VITE_ENABLE_BUILD_DEBUG === "true" && (
        <NodeDebugPanel
          nodes={nodes}
          isOpen={debugPanelOpen}
          onClose={() => setDebugPanelOpen(false)}
        />
      )}
    </div>
  );
}

export default HomePixi;

