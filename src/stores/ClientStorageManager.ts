/**
 * ClientStorageManager - Handles storage for browser environments only
 * Inspired by: https://story.vjy.me/how-i-simplified-my-figma-plugin-with-zustand-42
 */
import { JsonValue } from "@/types/types.ts";

export interface StorageManager<ObjectType extends JsonValue> {
  getItem(key: string): Promise<ObjectType | null>;
  setItem(key: string, value: ObjectType): Promise<void>;
  removeItem(key: string): Promise<void>;
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
  // Always return browser storage manager (no more Figma storage support)
  return new BrowserStorageManager<ObjectType>();
}