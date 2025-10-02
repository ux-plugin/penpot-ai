// Test script to verify the new messaging system works correctly with enhanced type safety
import { uiMessageDispatcher, uiStoreMessaging } from '@messaging/UIMessageDispatcher';
import { 
  MessageCategory, 
  OperationMessageType, 
  SystemMessageType,
  DrawRectangleRequest,
  CreateFrameRequest,
  InfoRequest,
  ExtractResultType,
  DrawRectangleResponse,
  CreateFrameResponse,
  InfoResponse
} from '@shared-core/types/messageTypes';
import { PersistableAuthState } from '@shared-core/types/authTypes';

// Test function to demonstrate enhanced messaging functionality with type safety
export async function testMessaging(): Promise<void> {
  console.log('[TEST] Starting messaging system test with enhanced type safety...');

  try {
    // Test 1: Send a type-safe operation request to create a rectangle
    console.log('[TEST] Sending draw rectangle operation...');
    const rectangleResult: ExtractResultType<DrawRectangleResponse> = await uiMessageDispatcher.sendRequest<
      Omit<DrawRectangleRequest, 'id' | 'timestamp' | 'source'>,
      ExtractResultType<DrawRectangleResponse>
    >({
      category: MessageCategory.OPERATION,
      type: OperationMessageType.DRAW_RECTANGLE,
      payload: {
        x: 100,
        y: 100,
        width: 200,
        height: 150,
        color: { r: 1, g: 0, b: 0 } // Red color
      }
    });
    console.log('[TEST] Rectangle creation result:', rectangleResult);
    console.log('[TEST] Created node ID:', rectangleResult.nodeId);
    console.log('[TEST] Rectangle dimensions:', `${rectangleResult.width}x${rectangleResult.height}`);

    // Test 2: Send type-safe system info request
    console.log('[TEST] Sending system info message...');
    const infoResult: ExtractResultType<InfoResponse> = await uiMessageDispatcher.sendRequest<
      Omit<InfoRequest, 'id' | 'timestamp' | 'source'>,
      ExtractResultType<InfoResponse>
    >({
      category: MessageCategory.SYSTEM,
      type: SystemMessageType.INFO,
      payload: {
        level: 'info',
        message: 'Messaging system test initiated'
      }
    });
    console.log('[TEST] System info result:', infoResult);
    console.log('[TEST] Message logged:', infoResult.logged);
    console.log('[TEST] Message handled:', infoResult.handled);

    // Test 3: Test type-safe store messaging
    console.log('[TEST] Testing store messaging...');
    const authPayload: Partial<PersistableAuthState> = {
      userId: 'test-user-123',
      accessToken: 'test-token',
      authProvider: 'FIGMA'
    };
    const storeUpdateResult = await uiStoreMessaging.updateState<Partial<PersistableAuthState>>(
      'authentication', 
      authPayload
    );
    console.log('[TEST] Store update result:', storeUpdateResult);
    console.log('[TEST] Update successful:', storeUpdateResult.updated);
    console.log('[TEST] Updated store ID:', storeUpdateResult.storeId);

    // Test 4: Send type-safe frame creation operation
    console.log('[TEST] Sending create frame operation...');
    const frameResult: ExtractResultType<CreateFrameResponse> = await uiMessageDispatcher.sendRequest<
      Omit<CreateFrameRequest, 'id' | 'timestamp' | 'source'>,
      ExtractResultType<CreateFrameResponse>
    >({
      category: MessageCategory.OPERATION,
      type: OperationMessageType.CREATE_FRAME,
      payload: {
        x: 300,
        y: 200,
        width: 400,
        height: 300,
        name: 'Test Frame'
      }
    });
    console.log('[TEST] Frame creation result:', frameResult);
    console.log('[TEST] Created frame ID:', frameResult.frameId);
    console.log('[TEST] Frame name:', frameResult.name);
    console.log('[TEST] Frame position:', `${frameResult.x}, ${frameResult.y}`);

    // Test 5: Test type-safe store state retrieval
    console.log('[TEST] Testing store state retrieval...');
    const stateResult = await uiStoreMessaging.getState<PersistableAuthState>('authentication');
    console.log('[TEST] Store state result:', stateResult);
    console.log('[TEST] Retrieved store ID:', stateResult.storeId);
    console.log('[TEST] Current auth state:', stateResult.state);
    console.log('[TEST] User ID:', stateResult.state.userId);
    console.log('[TEST] Access token present:', !!stateResult.state.accessToken);

    console.log('[TEST] All enhanced type-safe tests completed successfully!');

  } catch (error) {
    console.error('[TEST] Test failed:', error);
  }
}

// Export for use in other parts of the application
export default testMessaging;