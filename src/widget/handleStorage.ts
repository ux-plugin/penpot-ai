import {
  JsonValue,
  MessageType,
  StorageGetRequest,
  StorageGetResponse,
  StorageRemoveRequest,
  StorageRemoveResponse,
  StorageSaveRequest,
  StorageSaveResponse
} from "@/types.ts";

export const storageService = {
  async handleStorageSave(request: StorageSaveRequest) {
    const { id, key, value } = request;
    const saveResponse: StorageSaveResponse = {
      id: id,
      type: MessageType.storageSave,
      result: false
    };
    // Implement storage logic here
    try {
      await figma.clientStorage.setAsync(key, value);
      saveResponse.result = true;
    } catch (error: unknown) {
      if (error instanceof Error) {
        saveResponse.error = error.message;
      } else {
        console.error('Unexpected error in handleStorageSave:', error);
      }
    }
    figma.ui.postMessage(saveResponse);
  },
  async handleStorageRemove(request: StorageRemoveRequest) {
    const { id, key } = request;
    const removeResponse: StorageRemoveResponse = {
      id: id,
      type: MessageType.storageRemove,
      result: false
    };
    // Implement storage logic here
    try {
      await figma.clientStorage.deleteAsync(key);
      removeResponse.result = true;
    } catch (error: unknown) {
      if (error instanceof Error) {
        removeResponse.error = error.message;
      } else {
        console.error('Unexpected error in handleStorageRemove:', error);
      }
    }
    figma.ui.postMessage(removeResponse);
  },
  async handleStorageGet(request: StorageGetRequest) {
    const { id, key } = request;
    const getResponse: StorageGetResponse<JsonValue> = {
      id: id,
      type: MessageType.storageGet,
      result: null
    };
    // Implement storage logic here
    try {
      getResponse.result = await figma.clientStorage.getAsync(key);
    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error('Error getting storage value', error);
        getResponse.error = error.message;
      } else {
        console.error('Unexpected error in handleStorageGet:', error);
      }
    }
    figma.ui.postMessage(getResponse);
  }
}