import { IDesignPlatform } from '../IDesignPlatform';

export class DevImplementation implements IDesignPlatform {
  private _onmessage: ((message: any) => void | Promise<void>) | null = null;
  
  ui = {
    onmessage: null as ((message: any) => void | Promise<void>) | null,
    postMessage: (message: any) => {
      console.log('[DEV] Posting message to parent:', message);
      // In worker context, post back to main thread
      // Wrap the message in pluginMessage structure to match UI expectations
      if (typeof self !== 'undefined' && 'postMessage' in self) {
        self.postMessage({ pluginMessage: message });
      }
    },
    showUI: (_html: string, options = {}) => {
      console.log('[DEV] ShowUI called (no-op in dev):', { options });
    }
  };

  constructor() {
    // Set up proper getter/setter for onmessage with correct scope
    Object.defineProperty(this.ui, 'onmessage', {
      get: () => this._onmessage,
      set: (handler: ((message: any) => void | Promise<void>) | null) => {
        console.log('[DEV] Setting onmessage handler');
        this._onmessage = handler;
        
        // Set up worker message listener if we're in a worker context
        if (typeof self !== 'undefined' && 'addEventListener' in self) {
          self.addEventListener('message', async (event: MessageEvent) => {
            console.log('[DEV] Worker received message:', event.data);
            if (this._onmessage) {
              // Extract the pluginMessage from the event data to match UI structure
              const message = event.data.pluginMessage || event.data;
              await this._onmessage(message);
            }
          });
        }
      }
    });
  }

  closePlugin = () => {
    console.log('[DEV] ClosePlugin called (no-op in dev)');
  };

  getNodeByIdAsync = async (id: string) => {
    console.log('[DEV] GetNodeByIdAsync called:', id);
    return {
      id,
      type: 'FRAME',
      name: `MockNode_${id}`,
      x: 0,
      y: 0,
      width: 100,
      height: 100
    };
  };

  createFrame = () => {
    console.log('[DEV] CreateFrame called');
    const mockFrame = {
      id: `frame_${Date.now()}`,
      type: 'FRAME',
      name: 'MockFrame',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      rotation: 0,
      minWidth: null,
      maxWidth: null,
      minHeight: null,
      maxHeight: null,
      layoutMode: 'NONE',
      layoutAlign: 'INHERIT',
      layoutGrow: 0,
      primaryAxisSizingMode: 'FIXED',
      counterAxisSizingMode: 'FIXED',
      primaryAxisAlignItems: 'MIN',
      counterAxisAlignItems: 'MIN',
      paddingLeft: 0,
      paddingRight: 0,
      paddingTop: 0,
      paddingBottom: 0,
      itemSpacing: 0,
      fills: [],
      strokes: [],
      strokeWeight: 0,
      strokeAlign: 'INSIDE',
      cornerRadius: 0,
      opacity: 1,
      blendMode: 'NORMAL',
      effects: [],
      resize: (width: number, height: number) => {
        mockFrame.width = width;
        mockFrame.height = height;
      }
    };
    return mockFrame;
  };

  createRectangle = () => {
    console.log('[DEV] CreateRectangle called');
    const mockRectangle = {
      id: `rect_${Date.now()}`,
      type: 'RECTANGLE',
      name: 'MockRectangle',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      fills: [] as any[],
      strokes: [] as any[],
      resize: (width: number, height: number) => {
        mockRectangle.width = width;
        mockRectangle.height = height;
      }
    };
    return mockRectangle;
  };

  currentPage = {
    selection: [] as any[]
  };

  on = (event: string, _callback: () => void) => {
    console.log('[DEV] Event listener registered:', event);
    // In dev mode, we could simulate events or ignore them
  };

  getStyleByIdAsync = async (id: string) => {
    console.log('[DEV] GetStyleByIdAsync called:', id);
    return {
      id,
      name: `MockStyle_${id}`,
      type: 'PAINT'
    };
  };
}