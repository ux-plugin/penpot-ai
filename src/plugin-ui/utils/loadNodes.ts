import { uiMessageDispatcher } from "@/plugin-ui/UIMessageDispatcher.ts";
import {
  ExtractResultType,
  MessageCategory,
  GetAllNodesResponse,
  ExportNodeSVGsResponse,
  SystemMessageType,
} from "@shared-types/messageTypes.ts";
import { DesignNode } from "@shared-types/types.ts";

/**
 * Loads all nodes from Figma/design platform.
 * Retrieves pre-transformed design nodes ready for rendering.
 *
 * @param includeSVG - Whether to include SVG exports (slower but complete)
 * @returns Promise that resolves with the nodes array and total count
 */
export async function loadAllNodes(includeSVG: boolean = false): Promise<{
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
      payload: {
        includeSVG,
      },
    });

    console.log(
      `[loadNodes] Received ${result.nodes.length} design nodes (total: ${result.totalCount}, includeSVG: ${includeSVG})`,
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

/**
 * Exports SVGs for specific node IDs in parallel
 *
 * @param nodeIds - Array of node IDs to export SVGs for
 * @returns Promise that resolves with SVG data for each node
 */
export async function loadNodeSVGs(
  nodeIds: string[],
): Promise<Array<{ nodeId: string; svg: string | Uint8Array | null }>> {
  try {
    const result = await uiMessageDispatcher.sendRequest<
      Omit<any, "id" | "timestamp" | "source">,
      ExtractResultType<ExportNodeSVGsResponse>
    >({
      category: MessageCategory.SYSTEM,
      type: SystemMessageType.EXPORT_NODE_SVGS,
      payload: {
        nodeIds,
      },
    });

    console.log(
      `[loadNodeSVGs] Exported ${result.svgs.filter((s) => s.svg !== null).length} SVGs out of ${result.svgs.length} nodes`,
    );

    return result.svgs;
  } catch (error) {
    console.error("[loadNodeSVGs] Failed to export SVGs:", error);
    throw error;
  }
}
