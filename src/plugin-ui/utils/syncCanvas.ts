import { uiMessageDispatcher } from "@/plugin-ui/UIMessageDispatcher.ts";
import {
  ExtractResultType,
  MessageCategory,
  SyncCanvasRequest,
  SyncCanvasResponse,
  SystemMessageType
} from "@shared-types/messageTypes.ts";
import { Viewport } from "@xyflow/react";

/**
 * Syncs the ReactFlow canvas position and zoom with the Figma canvas.
 * This ensures the top-left corner of the ReactFlow canvas aligns with the
 * same coordinates as the Figma canvas beneath it, accounting for the 40 px header.
 *
 * @returns Promise that resolves when sync is complete
 */
export async function syncCanvasWithFigma(): Promise<Viewport> {
  try {
    console.log('[SYNC] Starting canvas sync...');
    
    // Request canvas sync data from Figma
    const result = await uiMessageDispatcher.sendRequest<
      Omit<SyncCanvasRequest, 'id' | 'timestamp' | 'source'>,
      ExtractResultType<SyncCanvasResponse>
    >({
      category: MessageCategory.SYSTEM,
      type: SystemMessageType.SYNC_CANVAS,
      payload: {}
    });

    console.log('[SYNC] Received sync data from Figma:', result);
    
    const { canvasPosition, zoom } = result;
    
    // Set the ReactFlow viewport to match Figma's canvas
    // ReactFlow viewport uses transformation matrix where:
    // - x and y are translation offsets (not absolute positions)
    // - To position canvas coordinate (cx, cy) at screen position (0, 0):
    //   viewport = { x: -cx * zoom, y: -cy * zoom, zoom }
    return {
      x: -canvasPosition.x * zoom,
      y: -canvasPosition.y * zoom,
      zoom: zoom
    };

  } catch (error) {
    console.error('[SYNC] Failed to sync canvas:', error);
    throw error;
  }
}
