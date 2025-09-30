// Test script to verify the new messaging system works correctly
import { uiMessageDispatcher, uiStoreMessaging } from '@/messaging/UIMessageDispatcher';
import { MessageCategory, OperationMessageType, SystemMessageType } from '@/types/messageTypes';

// Test function to demonstrate messaging functionality
export async function testMessaging() {
  console.log('[TEST] Starting messaging system test...');

  try {
    // Test 1: Send an operation request to create a rectangle
    console.log('[TEST] Sending draw rectangle operation...');
    const rectangleResult = await uiMessageDispatcher.sendRequest({
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

    // Test 2: Send system info request
    console.log('[TEST] Sending system info message...');
    const infoResult = await uiMessageDispatcher.sendRequest({
      category: MessageCategory.SYSTEM,
      type: SystemMessageType.INFO,
      payload: {
        level: 'info',
        message: 'Messaging system test initiated'
      }
    });
    console.log('[TEST] System info result:', infoResult);

    // Test 3: Test store messaging
    console.log('[TEST] Testing store messaging...');
    const storeUpdateResult = await uiStoreMessaging.updateState('authentication', {
      isAuthenticated: true,
      userId: 'test-user-123',
      accessToken: 'test-token'
    });
    console.log('[TEST] Store update result:', storeUpdateResult);

    // Test 4: Send frame creation operation
    console.log('[TEST] Sending create frame operation...');
    const frameResult = await uiMessageDispatcher.sendRequest({
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

    // Test 5: Test store state retrieval
    console.log('[TEST] Testing store state retrieval...');
    const stateResult = await uiStoreMessaging.getState('authentication');
    console.log('[TEST] Store state result:', stateResult);

    console.log('[TEST] All tests completed successfully!');

  } catch (error) {
    console.error('[TEST] Test failed:', error);
  }
}

// Export for use in other parts of the application
export default testMessaging;