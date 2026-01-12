import { IDesignPlatform } from "@widget/platform";
import type { DesignNode } from '@/shared/types/types';

export class PenpotImplementation implements IDesignPlatform {
  private _onmessage: ((message: any) => void | Promise<void>) | null = null;
  
  ui = {
    onmessage: null as ((message: any) => void | Promise<void>) | null,
    postMessage: (message: any) => {
      // Penpot's postMessage API - assuming similar to Figma
      if (typeof (globalThis as any).penpot !== 'undefined') {
        (globalThis as any).penpot.ui.postMessage(message);
      }
    },
    showUI: (html: string, options = {}) => {
      // Penpot's showUI API - assuming similar to Figma
      if (typeof (globalThis as any).penpot !== 'undefined') {
        (globalThis as any).penpot.ui.open(html, Object.assign({ width: 500, height: 500 }, options));
      }
    },
    resize: (width: number, height: number) => {
      // Penpot's resize API - assuming similar to Figma
      if (typeof (globalThis as any).penpot !== 'undefined') {
        (globalThis as any).penpot.ui.resize(width, height);
      }
    },
    reposition: (x: number, y: number) => {
      // Penpot's reposition API - assuming similar to Figma
      if (typeof (globalThis as any).penpot !== 'undefined' && (globalThis as any).penpot.ui.reposition) {
        (globalThis as any).penpot.ui.reposition(x, y);
      }
    },
    getPosition: async () => {
      // Penpot's getPosition API - assuming similar to Figma
      if (typeof (globalThis as any).penpot !== 'undefined' && (globalThis as any).penpot.ui.getPosition) {
        return await (globalThis as any).penpot.ui.getPosition();
      }
      // Fallback to default position
      return {
        windowSpace: { x: 0, y: 0 },
        canvasSpace: { x: 0, y: 0 }
      };
    }
  };

  constructor() {
    // Set up proper getter/setter for onmessage
    Object.defineProperty(this.ui, 'onmessage', {
      get: () => this._onmessage,
      set: (handler: ((message: any) => void | Promise<void>) | null) => {
        this._onmessage = handler;
        
        // Set up Penpot message listener
        if (typeof (globalThis as any).penpot !== 'undefined') {
          (globalThis as any).penpot.ui.onMessage.addListener(async (message: any) => {
            if (this._onmessage) {
              await this._onmessage(message);
            }
          });
        }
      }
    });
  }

  closePlugin = () => {
    if (typeof (globalThis as any).penpot !== 'undefined') {
      (globalThis as any).penpot.closePlugin();
    }
  };

  getNodeByIdAsync = async (id: string) => {
    // Penpot's node lookup API - assuming similar to Figma
    if (typeof (globalThis as any).penpot !== 'undefined') {
      return await (globalThis as any).penpot.getShapeById(id);
    }
    return null;
  };

  createFrame = () => {
    // Penpot's frame creation API
    if (typeof (globalThis as any).penpot !== 'undefined') {
      return (globalThis as any).penpot.createFrame();
    }
    return null;
  };

  createRectangle = () => {
    // Penpot's rectangle creation API
    if (typeof (globalThis as any).penpot !== 'undefined') {
      return (globalThis as any).penpot.createRectangle();
    }
    return null;
  };

  /**
   * Get all nodes - stub implementation for Penpot (not yet implemented)
   */
  getAllNodes = async (): Promise<DesignNode[]> => {
    // Return empty array - Penpot implementation not yet done
    return [];
  };

  currentPage = {
    get selection() {
      if (typeof (globalThis as any).penpot !== 'undefined') {
        return (globalThis as any).penpot.selection || [];
      }
      return [];
    },
    get children() {
      if (typeof (globalThis as any).penpot !== 'undefined' && (globalThis as any).penpot.page) {
        return (globalThis as any).penpot.page.children || [];
      }
      return [];
    },
    on: (event: string, callback: ((event?: any) => void) | (() => void)) => {
      // Penpot's page event listener API - assuming similar to Figma's PageNode.on()
      if (typeof (globalThis as any).penpot !== 'undefined' && (globalThis as any).penpot.page) {
        const page = (globalThis as any).penpot.page;
        if (page.on) {
          page.on(event, callback);
        } else if (page.addEventListener) {
          // Alternative API if Penpot uses addEventListener
          page.addEventListener(event, callback);
        }
      }
    }
  };

  viewport = {
    get bounds() {
      if (typeof (globalThis as any).penpot !== 'undefined' && (globalThis as any).penpot.viewport) {
        const viewport = (globalThis as any).penpot.viewport;
        // Validate that bounds exists and has the required properties
        if (
          viewport.bounds &&
          typeof viewport.bounds.x === 'number' &&
          typeof viewport.bounds.y === 'number' &&
          typeof viewport.bounds.width === 'number' &&
          typeof viewport.bounds.height === 'number'
        ) {
          return viewport.bounds;
        }
      }
      // Return default viewport bounds
      return {
        x: 0,
        y: 0,
        width: 1920,
        height: 1080
      };
    },
    get zoom() {
      if (typeof (globalThis as any).penpot !== 'undefined' && (globalThis as any).penpot.viewport) {
        const viewport = (globalThis as any).penpot.viewport;
        if (typeof viewport.zoom === 'number') {
          return viewport.zoom;
        }
      }
      // Return default zoom level
      return 1.0;
    },
    set zoom(value: number) {
      if (typeof (globalThis as any).penpot !== 'undefined' && (globalThis as any).penpot.viewport) {
        (globalThis as any).penpot.viewport.zoom = value;
      }
    },
    get center() {
      if (typeof (globalThis as any).penpot !== 'undefined' && (globalThis as any).penpot.viewport) {
        const viewport = (globalThis as any).penpot.viewport;
        if (viewport.center && typeof viewport.center.x === 'number' && typeof viewport.center.y === 'number') {
          return viewport.center;
        }
      }
      // Return default center
      return { x: 0, y: 0 };
    },
    set center(value: { x: number; y: number }) {
      if (typeof (globalThis as any).penpot !== 'undefined' && (globalThis as any).penpot.viewport) {
        (globalThis as any).penpot.viewport.center = value;
      }
    }
  };

  on = (event: string, callback: () => void) => {
    // Penpot's event listener API
    if (typeof (globalThis as any).penpot !== 'undefined') {
      (globalThis as any).penpot.on(event, callback);
    }
  };

  getStyleByIdAsync = async (id: string) => {
    // Penpot's style lookup API
    if (typeof (globalThis as any).penpot !== 'undefined') {
      return await (globalThis as any).penpot.getLibraryColorById(id);
    }
    return null;
  };

  storage = {
    setAsync: async (key: string, value: any) => {
      // Penpot's storage API - may use localStorage or plugin-specific storage
      if (typeof (globalThis as any).penpot !== 'undefined' && (globalThis as any).penpot.storage) {
        await (globalThis as any).penpot.storage.set(key, value);
      } else {
        localStorage.setItem(key, JSON.stringify(value));
      }
    },
    getAsync: async (key: string) => {
      // Penpot's storage API
      if (typeof (globalThis as any).penpot !== 'undefined' && (globalThis as any).penpot.storage) {
        return await (globalThis as any).penpot.storage.get(key);
      } else {
        const item = localStorage.getItem(key);
        return item ? JSON.parse(item) : undefined;
      }
    },
    deleteAsync: async (key: string) => {
      // Penpot's storage API
      if (typeof (globalThis as any).penpot !== 'undefined' && (globalThis as any).penpot.storage) {
        await (globalThis as any).penpot.storage.delete(key);
      } else {
        localStorage.removeItem(key);
      }
    }
  };
}
