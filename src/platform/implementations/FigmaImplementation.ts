import { IDesignPlatform } from "@/platform";

export class FigmaImplementation implements IDesignPlatform {
  ui = {
    onmessage: null as ((message: any) => void | Promise<void>) | null,
    postMessage: (message: any) => {
      console.log('[FIGMA] Sending UI message:', message);
      figma.ui.postMessage(message);
    },
    showUI: (html: string, options = {}) => {
      figma.showUI(html, Object.assign({ width: 500, height: 500 }, options));
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
    }
  };

  on = (event: string, callback: () => void) => {
    figma.on(event as any, callback);
  };

  getStyleByIdAsync = async (id: string) => {
    return await figma.getStyleByIdAsync(id);
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
