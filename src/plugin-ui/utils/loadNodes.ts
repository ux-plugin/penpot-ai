import { uiMessageDispatcher } from "@/plugin-ui/UIMessageDispatcher.ts";
import {
  ExtractResultType,
  MessageCategory,
  GetAllNodesResponse,
  SystemMessageType,
} from "@shared-types/messageTypes.ts";
import { DesignNode } from "@shared-types/types.ts";

/**
 * Loads all nodes from Figma/design platform.
 * Retrieves pre-transformed ReactFlow nodes ready for rendering.
 *
 * @returns Promise that resolves with the nodes array and total count
 */
export async function loadAllNodes(): Promise<{
  nodes: DesignNode[];
  totalCount: number;
}> {
  try {
    const result = await uiMessageDispatcher.sendRequest<
      Omit<any, "id" | "timestamp" | "source">,
      ExtractResultType<GetAllNodesResponse>
    >({
      category: MessageCategory.SYSTEM,
      type: SystemMessageType.GET_ALL_NODES,
      payload: {},
    });

    console.log(
      `[loadNodes] Received ${result.nodes.length} ReactFlow nodes (total: ${result.totalCount})`,
    );

    return {
      nodes: result.nodes,
      totalCount: result.totalCount,
    };
  } catch (error) {
    console.error("[loadNodes] Failed to load nodes:", error);
    throw error;
  }
}
