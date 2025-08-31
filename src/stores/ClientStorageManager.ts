/**
 * ClientStorageManager - Handles storage for both Figma plugin and browser environments
 * Inspired by: https://story.vjy.me/how-i-simplified-my-figma-plugin-with-zustand-42
 */
import { JsonValue, MessageType, StorageGetRequest, StorageGetResponse, StorageRemoveRequest, StorageRemoveResponse, StorageSaveRequest, StorageSaveResponse } from "@/types.ts";
import { messageDispatcher } from "@/utils/FigmaUiPluginMessaging.ts";

export interface StorageManager<ObjectType extends JsonValue> {
  getItem(key: string): Promise<ObjectType | null>;
  setItem(key: string, value: ObjectType): Promise<void>;
  removeItem(key: string): Promise<void>;
}

class FigmaStorageManager<ObjectType extends JsonValue> implements StorageManager<ObjectType> {
  async getItem(key: string): Promise<ObjectType|null> {
    const request: Omit<StorageGetRequest, 'id'>= {key: key, type: MessageType.storageGet}
    return messageDispatcher.sendMessage<StorageGetResponse<ObjectType>>(request).then(response => {
      if (!response.error) {
        return response.result;
      } else {
        throw new Error(response.error);
      }
    });
  }

  async setItem(key: string, value: ObjectType): Promise<void> {
    const request: Omit<StorageSaveRequest, 'id'> = {key: key, type: MessageType.storageSave, value: value}
    messageDispatcher.sendMessage<StorageSaveResponse>(request).then(response => {
      if (response.error) {
        throw new Error(response.error);
      }
      return;
    })
  }

  async removeItem(key: string): Promise<void> {
    const request: Omit<StorageRemoveRequest, 'id'> = {key: key, type: MessageType.storageRemove}
    messageDispatcher.sendMessage<StorageRemoveResponse>(request).then(response => {
      if (response.error) {
        throw new Error(response.error);
      }
      return;
    })
  }
}

class BrowserStorageManager<ObjectType extends JsonValue> implements StorageManager<ObjectType> {
  async getItem(key: string): Promise<ObjectType|null> {
    try {
      const unparsedValue = localStorage.getItem(key);
      if (unparsedValue === null) {
        return null;
      }
      return JSON.parse(unparsedValue);
    } catch (error) {
      console.error('Error getting item from browser storage:', error);
      return null;
    }
  }

  async setItem(key: string, value: ObjectType): Promise<void> {
    try {
      localStorage.setItem(key, JSON.stringify(value) );
    } catch (error) {
      console.error('Error setting item in browser storage:', error);
    }
  }

  async removeItem(key: string): Promise<void> {
    try {
      localStorage.removeItem(key);
    } catch (error) {
      console.error('Error removing item from browser storage:', error);
    }
  }
}

// Update the function signature to enforce JSON serializable constraints
export function createStorageManager<ObjectType extends JsonValue>(): StorageManager<ObjectType> {
  // Check if we're in a Figma plugin environment
  if (typeof figma !== 'undefined' && figma.currentPage) {
    return new FigmaStorageManager<ObjectType>();
  } else {
    // Assume browser environment if not in Figma
    return new BrowserStorageManager<ObjectType>();
  }
}