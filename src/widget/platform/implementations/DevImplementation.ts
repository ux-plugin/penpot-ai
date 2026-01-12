import { IDesignPlatform, BaseSceneNode } from "../IDesignPlatform";
import type { DesignNode } from "@/shared/types/types";

export class DevImplementation implements IDesignPlatform {
  private _onmessage: ((message: any) => void | Promise<void>) | null = null;

  ui = {
    onmessage: null as ((message: any) => void | Promise<void>) | null,
    postMessage: (message: any) => {
      // In worker context, post back to main thread
      // Wrap the message in pluginMessage structure to match UI expectations
      if (typeof self !== "undefined" && "postMessage" in self) {
        self.postMessage({ pluginMessage: message });
      }
    },
    showUI: (_html: string, _ = {}) => {
      // No-op in dev mode
    },
    resize: (width: number, height: number) => {
      // Post resize event to parent/host for dev environment
      if (typeof self !== "undefined" && "postMessage" in self) {
        self.postMessage({
          type: "resize",
          width,
          height,
        });
      }
    },
    reposition: (x: number, y: number) => {
      // Post reposition event to parent/host for dev environment
      if (typeof self !== "undefined" && "postMessage" in self) {
        self.postMessage({
          type: "reposition",
          x,
          y,
        });
      }
    },
    getPosition: async (): Promise<{
      windowSpace: { x: number; y: number };
      canvasSpace: { x: number; y: number };
    }> => {
      // Post get position request to parent/host for dev environment
      if (typeof self !== "undefined" && "postMessage" in self) {
        return new Promise<{
          windowSpace: { x: number; y: number };
          canvasSpace: { x: number; y: number };
        }>((resolve) => {
          const requestId = `getPosition_${Date.now()}`;

          // Set up one-time listener for the response
          const listener = (event: MessageEvent) => {
            if (
              event.data.type === "getPosition-response" &&
              event.data.requestId === requestId
            ) {
              self.removeEventListener("message", listener);
              resolve(event.data.position);
            }
          };

          self.addEventListener("message", listener);

          // Send the request
          self.postMessage({
            type: "getPosition",
            requestId,
          });

          // Timeout after 5 seconds
          setTimeout(() => {
            self.removeEventListener("message", listener);
            console.warn(
              "[DEV] GetPosition timeout, returning default position",
            );
            resolve({
              windowSpace: { x: 0, y: 0 },
              canvasSpace: { x: 0, y: 0 },
            });
          }, 5000);
        });
      }

      // Fallback if not in worker context
      return {
        windowSpace: { x: 0, y: 0 },
        canvasSpace: { x: 0, y: 0 },
      };
    },
  };

  constructor() {
    // Set up proper getter/setter for onmessage with correct scope
    Object.defineProperty(this.ui, "onmessage", {
      get: () => this._onmessage,
      set: (handler: ((message: any) => void | Promise<void>) | null) => {
        this._onmessage = handler;

        // Set up worker message listener if we're in a worker context
        if (typeof self !== "undefined" && "addEventListener" in self) {
          self.addEventListener("message", async (event: MessageEvent) => {
            if (this._onmessage) {
              // Extract the pluginMessage from the event data to match UI structure
              const message = event.data.pluginMessage || event.data;
              await this._onmessage(message);
            }
          });
        }
      },
    });

    // Set up proper getter/setter for viewport zoom and center with correct scope
    Object.defineProperty(this.viewport, "zoom", {
      get: () => this._viewportZoom,
      set: (value: number) => {
        this._viewportZoom = value;
      },
    });

    Object.defineProperty(this.viewport, "center", {
      get: () => this._viewportCenter,
      set: (value: { x: number; y: number }) => {
        this._viewportCenter = value;
      },
    });
  }

  closePlugin = () => {
    // No-op in dev mode
  };

  getNodeByIdAsync = async (id: string) => {
    return {
      id,
      type: "FRAME",
      name: `MockNode_${id}`,
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    };
  };

  createFrame = () => {
    const mockFrame = {
      id: `frame_${Date.now()}`,
      type: "FRAME",
      name: "MockFrame",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      rotation: 0,
      minWidth: null,
      maxWidth: null,
      minHeight: null,
      maxHeight: null,
      layoutMode: "NONE",
      layoutAlign: "INHERIT",
      layoutGrow: 0,
      primaryAxisSizingMode: "FIXED",
      counterAxisSizingMode: "FIXED",
      primaryAxisAlignItems: "MIN",
      counterAxisAlignItems: "MIN",
      paddingLeft: 0,
      paddingRight: 0,
      paddingTop: 0,
      paddingBottom: 0,
      itemSpacing: 0,
      fills: [],
      strokes: [],
      strokeWeight: 0,
      strokeAlign: "INSIDE",
      cornerRadius: 0,
      opacity: 1,
      blendMode: "NORMAL",
      effects: [],
      resize: (width: number, height: number) => {
        mockFrame.width = width;
        mockFrame.height = height;
      },
    };
    return mockFrame;
  };

  createRectangle = () => {
    const mockRectangle = {
      id: `rect_${Date.now()}`,
      type: "RECTANGLE",
      name: "MockRectangle",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      fills: [] as any[],
      strokes: [] as any[],
      resize: (width: number, height: number) => {
        mockRectangle.width = width;
        mockRectangle.height = height;
      },
    };
    return mockRectangle;
  };

  /**
   * Get all nodes - stub implementation for dev mode
   */
  getAllNodes = async (includeSVG?: boolean): Promise<DesignNode[]> => {
    // Return empty array in dev mode
    console.log("[DEV] getAllNodes request received", {
      includeSVG: includeSVG,
    });
    return [];
  };

  currentPage = {
    selection: [] as any[],
    children: [] as BaseSceneNode[],
    on: (_event: string, _callback: ((event?: any) => void) | (() => void)) => {
      // No-op in dev mode - could simulate events if needed
    },
  };

  private _viewportZoom = 1.0;
  private _viewportCenter = { x: 0, y: 0 };

  viewport = {
    bounds: {
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
    },
    zoom: 1.0,
    center: { x: 0, y: 0 },
  };

  on = (_: string, _callback: () => void) => {
    // In dev mode, we could simulate events or ignore them
  };

  getStyleByIdAsync = async (id: string) => {
    return {
      id,
      name: `MockStyle_${id}`,
      type: "PAINT",
    };
  };

  storage = {
    setAsync: async (key: string, value: any) => {
      try {
        // Check if we're in a worker with the async bridge
        const storage = (globalThis as any).localStorageAsync || localStorage;
        if (
          storage.setItem.constructor.name === "AsyncFunction" ||
          (globalThis as any).localStorageAsync
        ) {
          await storage.setItem(key, JSON.stringify(value));
        } else {
          storage.setItem(key, JSON.stringify(value));
        }
      } catch (error) {
        console.error("[DEV] localStorage setItem failed:", error);
        throw error;
      }
    },
    getAsync: async (key: string) => {
      try {
        // Check if we're in a worker with the async bridge
        const storage = (globalThis as any).localStorageAsync || localStorage;
        let item: string | null;
        if (
          storage.getItem.constructor.name === "AsyncFunction" ||
          (globalThis as any).localStorageAsync
        ) {
          item = await storage.getItem(key);
        } else {
          item = storage.getItem(key);
        }
        const value = item ? JSON.parse(item) : undefined;
        return value;
      } catch (error) {
        console.error("[DEV] localStorage getItem failed:", error);
        return undefined;
      }
    },
    deleteAsync: async (key: string) => {
      try {
        // Check if we're in a worker with the async bridge
        const storage = (globalThis as any).localStorageAsync || localStorage;
        if (
          storage.removeItem.constructor.name === "AsyncFunction" ||
          (globalThis as any).localStorageAsync
        ) {
          await storage.removeItem(key);
        } else {
          storage.removeItem(key);
        }
      } catch (error) {
        console.error("[DEV] localStorage removeItem failed:", error);
        throw error;
      }
    },
  };
}
