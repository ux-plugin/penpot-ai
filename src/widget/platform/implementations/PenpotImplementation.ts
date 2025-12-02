import { IDesignPlatform } from '../IDesignPlatform';

export class PenpotImplementation implements IDesignPlatform {
  private _onmessage: ((message: any) => void | Promise<void>) | null = null;
  
  ui = {
    onmessage: null as ((message: any) => void | Promise<void>) | null,
    postMessage: (message: any) => {
      console.log('[PENPOT] Posting message:', message);
      // Penpot's postMessage API - assuming similar to Figma
      if (typeof (globalThis as any).penpot !== 'undefined') {
        (globalThis as any).penpot.ui.postMessage(message);
      }
    },
    showUI: (html: string, options = {}) => {
      console.log('[PENPOT] ShowUI called:', { options });
      // Penpot's showUI API - assuming similar to Figma
      if (typeof (globalThis as any).penpot !== 'undefined') {
        (globalThis as any).penpot.ui.open(html, Object.assign({ width: 500, height: 500 }, options));
      }
    },
    resize: (width: number, height: number) => {
      console.log('[PENPOT] Resize called:', { width, height });
      // Penpot's resize API - assuming similar to Figma
      if (typeof (globalThis as any).penpot !== 'undefined') {
        (globalThis as any).penpot.ui.resize(width, height);
      }
    },
    reposition: (x: number, y: number) => {
      console.log('[PENPOT] Reposition called:', { x, y });
      // Penpot's reposition API - assuming similar to Figma
      if (typeof (globalThis as any).penpot !== 'undefined' && (globalThis as any).penpot.ui.reposition) {
        (globalThis as any).penpot.ui.reposition(x, y);
      }
    },
    getPosition: async () => {
      console.log('[PENPOT] GetPosition called');
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
        console.log('[PENPOT] Setting onmessage handler');
        this._onmessage = handler;
        
        // Set up Penpot message listener
        if (typeof (globalThis as any).penpot !== 'undefined') {
          (globalThis as any).penpot.ui.onMessage.addListener(async (message: any) => {
            console.log('[PENPOT] Received message:', message);
            if (this._onmessage) {
              await this._onmessage(message);
            }
          });
        }
      }
    });
  }

  closePlugin = () => {
    console.log('[PENPOT] ClosePlugin called');
    if (typeof (globalThis as any).penpot !== 'undefined') {
      (globalThis as any).penpot.closePlugin();
    }
  };

  getNodeByIdAsync = async (id: string) => {
    console.log('[PENPOT] GetNodeByIdAsync called:', id);
    // Penpot's node lookup API - assuming similar to Figma
    if (typeof (globalThis as any).penpot !== 'undefined') {
      return await (globalThis as any).penpot.getShapeById(id);
    }
    return null;
  };

  createFrame = () => {
    console.log('[PENPOT] CreateFrame called');
    // Penpot's frame creation API
    if (typeof (globalThis as any).penpot !== 'undefined') {
      return (globalThis as any).penpot.createFrame();
    }
    return null;
  };

  createRectangle = () => {
    console.log('[PENPOT] CreateRectangle called');
    // Penpot's rectangle creation API
    if (typeof (globalThis as any).penpot !== 'undefined') {
      return (globalThis as any).penpot.createRectangle();
    }
    return null;
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
    }
  };

  viewport = {
    get bounds() {
      if (typeof (globalThis as any).penpot !== 'undefined' && (globalThis as any).penpot.viewport) {
        return (globalThis as any).penpot.viewport.bounds;
      }
      // Return default viewport bounds
      return {
        x: 0,
        y: 0,
        width: 1920,
        height: 1080
      };
    }
  };

  on = (event: string, callback: () => void) => {
    console.log('[PENPOT] Event listener registered:', event);
    // Penpot's event listener API
    if (typeof (globalThis as any).penpot !== 'undefined') {
      (globalThis as any).penpot.on(event, callback);
    }
  };

  getStyleByIdAsync = async (id: string) => {
    console.log('[PENPOT] GetStyleByIdAsync called:', id);
    // Penpot's style lookup API
    if (typeof (globalThis as any).penpot !== 'undefined') {
      return await (globalThis as any).penpot.getLibraryColorById(id);
    }
    return null;
  };

  storage = {
    setAsync: async (key: string, value: any) => {
      console.log('[PENPOT] Storage setAsync:', key, value);
      // Penpot's storage API - may use localStorage or plugin-specific storage
      if (typeof (globalThis as any).penpot !== 'undefined' && (globalThis as any).penpot.storage) {
        await (globalThis as any).penpot.storage.set(key, value);
      } else {
        localStorage.setItem(key, JSON.stringify(value));
      }
    },
    getAsync: async (key: string) => {
      console.log('[PENPOT] Storage getAsync:', key);
      // Penpot's storage API
      if (typeof (globalThis as any).penpot !== 'undefined' && (globalThis as any).penpot.storage) {
        return await (globalThis as any).penpot.storage.get(key);
      } else {
        const item = localStorage.getItem(key);
        return item ? JSON.parse(item) : undefined;
      }
    },
    deleteAsync: async (key: string) => {
      console.log('[PENPOT] Storage deleteAsync:', key);
      // Penpot's storage API
      if (typeof (globalThis as any).penpot !== 'undefined' && (globalThis as any).penpot.storage) {
        await (globalThis as any).penpot.storage.delete(key);
      } else {
        localStorage.removeItem(key);
      }
    }
  };
}
