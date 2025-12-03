import { uiMessageDispatcher } from '@/plugin-ui/UIMessageDispatcher.ts';
import { MessageCategory, SystemMessageType, SyncCanvasRequest, SyncCanvasResponse, ExtractResultType } from '@/messaging/types/messageTypes';
import { ReactFlowInstance } from '@xyflow/react';

/**
 * Syncs the ReactFlow canvas position and zoom with the Figma canvas.
 * This ensures the top-left corner of the ReactFlow canvas aligns with the
 * same coordinates as the Figma canvas beneath it, accounting for the 24px header.
 * 
 * @param reactFlowInstance - The ReactFlow instance to sync
 * @returns Promise that resolves when sync is complete
 */
export async function syncCanvasWithFigma(reactFlowInstance: ReactFlowInstance): Promise<void> {
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
    // The canvasPosition already accounts for the 24px header adjustment
    reactFlowInstance.setViewport({
      x: -canvasPosition.x,  // Negative because ReactFlow viewport x is the opposite direction
      y: -canvasPosition.y,  // Negative because ReactFlow viewport y is the opposite direction
      zoom: zoom
    });
    
    console.log('[SYNC] Canvas synced successfully');
    console.log('[SYNC] ReactFlow viewport set to:', {
      x: -canvasPosition.x,
      y: -canvasPosition.y,
      zoom: zoom
    });
  } catch (error) {
    console.error('[SYNC] Failed to sync canvas:', error);
    throw error;
  }
}
