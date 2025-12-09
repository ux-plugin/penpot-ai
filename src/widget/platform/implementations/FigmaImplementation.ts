import { IDesignPlatform } from "@widget/platform";
import type { DesignNode, FrameNodeType, TextNodeType } from "@/shared/types/types";

export class FigmaImplementation implements IDesignPlatform {
  ui = {
    onmessage: null as ((message: any) => void | Promise<void>) | null,
    postMessage: (message: any) => {
      figma.ui.postMessage(message);
    },
    showUI: (html: string, options = {}) => {
      figma.showUI(html, Object.assign({ width: 500, height: 500 }, options));
    },
    resize: (width: number, height: number) => {
      figma.ui.resize(width, height);
    },
    reposition: (x: number, y: number) => {
      figma.ui.reposition(x, y);
    },
    getPosition: async () => {
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

  /**
   * Extract all properties from a Figma FrameNode, including children recursively
   */
  private extractFrameProperties(frameNode: FrameNode): FrameNodeType {
    const frameProperties: FrameNodeType = {
      id: frameNode.id,
      name: frameNode.name,
      type: 'FRAME' as const,
      visible: frameNode.visible,
      locked: frameNode.locked,

      // Position and size
      x: frameNode.x,
      y: frameNode.y,
      width: frameNode.width,
      height: frameNode.height,
      rotation: frameNode.rotation,

      // Layout properties
      layoutMode: frameNode.layoutMode,
      layoutAlign: frameNode.layoutAlign,
      layoutGrow: frameNode.layoutGrow,
      primaryAxisSizingMode: frameNode.primaryAxisSizingMode,
      counterAxisSizingMode: frameNode.counterAxisSizingMode,
      primaryAxisAlignItems: frameNode.primaryAxisAlignItems,
      counterAxisAlignItems: frameNode.counterAxisAlignItems,
      paddingLeft: frameNode.paddingLeft,
      paddingRight: frameNode.paddingRight,
      paddingTop: frameNode.paddingTop,
      paddingBottom: frameNode.paddingBottom,
      itemSpacing: frameNode.itemSpacing,

      // Style properties
      fills: frameNode.fills,
      strokes: frameNode.strokes,
      strokeWeight: frameNode.strokeWeight,
      strokeAlign: frameNode.strokeAlign,
      cornerRadius: frameNode.cornerRadius,
      opacity: frameNode.opacity,
      blendMode: frameNode.blendMode,

      // Style IDs
      fillStyleId: frameNode.fillStyleId,
      strokeStyleId: frameNode.strokeStyleId,
      effectStyleId: frameNode.effectStyleId,

      // Effects
      effects: frameNode.effects,

      // Children - recursively extract child nodes
      children: []
    };

    // Recursively process children
    frameNode.children.forEach((child) => {
      if (child.type === "FRAME") {
        frameProperties.children.push(this.extractFrameProperties(child as FrameNode));
      } else if (child.type === "TEXT") {
        frameProperties.children.push(this.extractTextProperties(child as TextNode));
      }
    });

    return frameProperties;
  }

  /**
   * Extract all properties from a Figma TextNode
   */
  private extractTextProperties(textNode: TextNode): TextNodeType {
    return {
      id: textNode.id,
      name: textNode.name,
      type: 'TEXT' as const,
      visible: textNode.visible,
      locked: textNode.locked,

      // Position and size
      x: textNode.x,
      y: textNode.y,
      width: textNode.width,
      height: textNode.height,
      rotation: textNode.rotation,

      // Text content
      characters: textNode.characters,

      // Text style properties
      fontSize: textNode.fontSize,
      fontName: textNode.fontName,
      textAlignHorizontal: textNode.textAlignHorizontal,
      textAlignVertical: textNode.textAlignVertical,
      letterSpacing: textNode.letterSpacing,
      lineHeight: textNode.lineHeight,
      textCase: textNode.textCase,
      textDecoration: textNode.textDecoration,

      // Style properties
      fills: textNode.fills,
      strokes: textNode.strokes,
      strokeWeight: textNode.strokeWeight,
      opacity: textNode.opacity,
      blendMode: textNode.blendMode,

      // Style IDs
      fillStyleId: textNode.fillStyleId,
      strokeStyleId: textNode.strokeStyleId,
      effectStyleId: textNode.effectStyleId,
      textStyleId: textNode.textStyleId,

      // Effects
      effects: textNode.effects,
    };
  }

  /**
   * Get all nodes (frames and texts) from the current page with hierarchy preserved
   */
  getAllNodes = (): DesignNode[] => {
    const nodes: DesignNode[] = [];
    const currentPageChildren = figma.currentPage.children;

    for (const child of currentPageChildren) {
      if (child.type === "FRAME") {
        nodes.push(this.extractFrameProperties(child as FrameNode));
      } else if (child.type === "TEXT") {
        nodes.push(this.extractTextProperties(child as TextNode));
      }
    }

    return nodes;
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
    },
    get zoom() {
      return figma.viewport.zoom;
    },
    set zoom(value: number) {
      figma.viewport.zoom = value;
    },
    get center() {
      return figma.viewport.center;
    },
    set center(value: { x: number; y: number }) {
      figma.viewport.center = value;
    }
  };

  getStyleByIdAsync = async (id: string) => {
    return await figma.getStyleByIdAsync(id);
  }


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
