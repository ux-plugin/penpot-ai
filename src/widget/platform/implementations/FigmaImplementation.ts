import { IDesignPlatform } from "@widget/platform";

export class FigmaImplementation implements IDesignPlatform {
  ui = {
    onmessage: null as ((message: any) => void | Promise<void>) | null,
    postMessage: (message: any) => {
      console.log('[FIGMA] Sending UI message:', message);
      figma.ui.postMessage(message);
    },
    showUI: (html: string, options = {}) => {
      figma.showUI(html, Object.assign({ width: 500, height: 500 }, options));
    },
    resize: (width: number, height: number) => {
      console.log('[FIGMA] Resizing UI to:', { width, height });
      figma.ui.resize(width, height);
    },
    reposition: (x: number, y: number) => {
      console.log('[FIGMA] Repositioning UI to:', { x, y });
      figma.ui.reposition(x, y);
    },
    getPosition: async () => {
      console.log('[FIGMA] Getting UI position');
      return figma.ui.getPosition();
    }
  };

  closePlugin = () => {
    figma.closePlugin();
  };

  getNodeByIdAsync = async (id: string) => {
    return await figma.getNodeByIdAsync(id);
  };

  createFrame = () => {
    return figma.createFrame();
  };

  createRectangle = () => {
    return figma.createRectangle();
  };

  currentPage = {
    get selection() {
      return figma.currentPage.selection;
    },
    get children() {
      return figma.currentPage.children;
    }
  };

  on = (event: string, callback: () => void) => {
    figma.on(event as any, callback);
  };

  viewport = {
    get bounds() {
      return figma.viewport.bounds;
    }
  };

  getStyleByIdAsync = async (id: string) => {
    return await figma.getStyleByIdAsync(id);
  };

  storage = {
    setAsync: async (key: string, value: any) => {
      return await figma.clientStorage.setAsync(key, value);
    },
    getAsync: async (key: string) => {
      return await figma.clientStorage.getAsync(key);
    },
    deleteAsync: async (key: string) => {
      return await figma.clientStorage.deleteAsync(key);
    }
  };

  constructor() {
    // Bridge figma.ui.onmessage to our interface
    Object.defineProperty(this.ui, 'onmessage', {
      get: () => figma.ui.onmessage,
      set: (handler) => {
        figma.ui.onmessage = handler;
      }
    });
  }
}
