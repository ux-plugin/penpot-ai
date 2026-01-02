import { IDesignPlatform } from "@widget/platform";
import type { DesignNode } from "@/shared/types/types";
import { ReactFlowFrameNodeType, TextNodeType } from "@components/nodes";

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
    },
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
   * Extract basic properties from a Figma FrameNode, ComponentNode, or ComponentSetNode (without SVG)
   */
  private extractFrameNodeBasicProperties(
    frameNode: FrameNode | ComponentNode | ComponentSetNode,
    parentId?: string,
  ): ReactFlowFrameNodeType {
    // Normalize strokeWeight to always be an object with 4 values
    let normalizedStrokeWeight:
      | { top: number; right: number; bottom: number; left: number }
      | undefined;
    if (frameNode.strokeWeight !== undefined) {
      if (typeof frameNode.strokeWeight === "number") {
        // Uniform stroke weight
        normalizedStrokeWeight = {
          top: frameNode.strokeWeight,
          right: frameNode.strokeWeight,
          bottom: frameNode.strokeWeight,
          left: frameNode.strokeWeight,
        };
      } else {
        normalizedStrokeWeight = {
          top: frameNode.strokeTopWeight,
          right: frameNode.strokeRightWeight,
          bottom: frameNode.strokeBottomWeight,
          left: frameNode.strokeLeftWeight,
        };
      }
    }

    // Normalize cornerRadius to always be an object with 4 values
    let normalizedCornerRadius:
      | {
          topLeft: number;
          topRight: number;
          bottomLeft: number;
          bottomRight: number;
        }
      | undefined;
    if (frameNode.cornerRadius !== undefined) {
      if (typeof frameNode.cornerRadius === "number") {
        // Uniform corner radius
        normalizedCornerRadius = {
          topLeft: frameNode.cornerRadius,
          topRight: frameNode.cornerRadius,
          bottomLeft: frameNode.cornerRadius,
          bottomRight: frameNode.cornerRadius,
        };
      } else {
        normalizedCornerRadius = {
          topLeft: frameNode.topLeftRadius,
          topRight: frameNode.topRightRadius,
          bottomLeft: frameNode.bottomLeftRadius,
          bottomRight: frameNode.bottomRightRadius,
        };
      }
    }

    return {
      id: frameNode.id,
      type: "figmaNode",
      parentId: parentId,
      position: {
        x: frameNode.x,
        y: frameNode.y,
      },
      data: {
        label: frameNode.name,
        name: frameNode.name,
        locked: frameNode.locked,
        visible: frameNode.visible,
        opacity: frameNode.opacity,
        rotation: frameNode.rotation,
        nodeType: frameNode.type as "FRAME" | "COMPONENT" | "COMPONENT_SET",

        // Dimensions
        width: frameNode.width,
        height: frameNode.height,

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
        fills: frameNode.fills as ReadonlyArray<Paint>,
        strokes: frameNode.strokes,
        strokeWeight: normalizedStrokeWeight,
        strokeAlign: frameNode.strokeAlign,
        cornerRadius: normalizedCornerRadius,
        blendMode: frameNode.blendMode,

        // Style IDs
        fillStyleId: frameNode.fillStyleId as string,
        strokeStyleId: frameNode.strokeStyleId,
        effectStyleId: frameNode.effectStyleId,

        // Effects
        effects: frameNode.effects,

        // Children - empty array, children are added to top level instead
        children: [],
      },
      width: frameNode.width,
      height: frameNode.height,
      draggable: false,
      selectable: false,
    };
  }

  /**
   * Export SVG for a FrameNode, ComponentNode, or ComponentSetNode
   */
  private async exportFrameNodeSVG(
    frameNode: FrameNode | ComponentNode | ComponentSetNode,
  ): Promise<Uint8Array> {
    const svgExportStartTime = Date.now();
    const svg = await frameNode.exportAsync({
      format: "SVG",
    });
    const svgExportEndTime = Date.now();
    const svgExportDuration = svgExportEndTime - svgExportStartTime;
    console.log(
      `[SVG Export] Frame node "${frameNode.name}" (${frameNode.id}): ${svgExportDuration.toFixed(2)}ms`,
    );
    return svg;
  }

  /**
   * Extract basic properties from a Figma TextNode (without SVG)
   */
  private extractTextNodeBasicProperties(
    textNode: TextNode,
    parentId?: string,
  ): TextNodeType {
    // Extract styled text segments with all available properties
    const segments = textNode.getStyledTextSegments([
      "fontSize",
      "fontName",
      "fontWeight",
      "textDecoration",
      "textDecorationStyle",
      "textDecorationOffset",
      "textDecorationThickness",
      "textDecorationColor",
      "textDecorationSkipInk",
      "textCase",
      "lineHeight",
      "letterSpacing",
      "fills",
      "textStyleId",
      "fillStyleId",
      "listOptions",
      "listSpacing",
      "indentation",
      "paragraphIndent",
      "paragraphSpacing",
      "hyperlink",
      "openTypeFeatures",
      "boundVariables",
      "textStyleOverrides",
    ]);

    return {
      id: textNode.id,
      type: "textNode" as const,
      parentId: parentId,
      position: {
        x: textNode.x,
        y: textNode.y,
      },
      data: {
        label: textNode.name,
        name: textNode.name,
        visible: textNode.visible,
        locked: textNode.locked,
        opacity: textNode.opacity,
        rotation: textNode.rotation,
        text: textNode.characters,

        // Text content
        characters: textNode.characters,

        // Text box alignment properties (not segment-specific)
        textAlignHorizontal: textNode.textAlignHorizontal,
        textAlignVertical: textNode.textAlignVertical,

        // Node-level style properties (not segment-specific)
        strokes: textNode.strokes,
        strokeWeight: textNode.strokeWeight as number,
        blendMode: textNode.blendMode,

        // Node-level style IDs
        strokeStyleId: textNode.strokeStyleId,
        effectStyleId: textNode.effectStyleId,

        // Effects
        effects: textNode.effects,

        // Styled text segments - each segment has its own styles
        segments: segments,
      },
      width: textNode.width,
      height: textNode.height,
      draggable: false,
      selectable: false,
    };
  }

  /**
   * Export SVG for a TextNode
   */
  private async exportTextNodeSVG(textNode: TextNode): Promise<string> {
    const svgExportStartTime = Date.now();
    const svg = await textNode.exportAsync({
      format: "SVG_STRING",
      svgOutlineText: true,
    });
    const svgExportEndTime = Date.now();
    const svgExportDuration = svgExportEndTime - svgExportStartTime;
    console.log(
      `[SVG Export] Text node "${textNode.name}" (${textNode.id}): ${svgExportDuration.toFixed(2)}ms`,
    );
    return svg;
  }

  /**
   * Get all nodes (frames and texts) from the current page - top level only
   * Extracts basic properties first (without SVG) for faster initial rendering
   */
  getAllNodes = async (includeSVG: boolean = false): Promise<DesignNode[]> => {
    const nodes: DesignNode[] = [];
    const currentPageChildren = figma.currentPage.children;

    // First pass: Extract all basic properties (fast, synchronous)
    this.transformNodesToDesignNodesBasic(currentPageChildren, nodes);

    // Second pass: Export SVGs in parallel if requested
    if (includeSVG) {
      await this.addSVGsToNodes(nodes);
    }

    return nodes;
  };

  /**
   * Transform nodes to DesignNodes with basic properties only (no SVG)
   */
  private transformNodesToDesignNodesBasic(
    currentPageChildren: ReadonlyArray<SceneNode>,
    nodes: DesignNode[],
    parentId?: string,
  ) {
    for (const child of currentPageChildren) {
      if (
        child.type === "FRAME" ||
        child.type === "COMPONENT" ||
        child.type === "COMPONENT_SET"
      ) {
        const frameNode = child as FrameNode | ComponentNode | ComponentSetNode;
        // Add the frame/component to the flat array (without processing children)
        nodes.push(this.extractFrameNodeBasicProperties(frameNode, parentId));
      } else if (child.type === "TEXT") {
        // Add the text node to the flat array
        nodes.push(
          this.extractTextNodeBasicProperties(child as TextNode, parentId),
        );
      }
    }
  }

  /**
   * Add SVGs to nodes in parallel
   */
  private async addSVGsToNodes(nodes: DesignNode[]): Promise<void> {
    const svgPromises = nodes.map(async (node) => {
      try {
        const figmaNode = await figma.getNodeByIdAsync(node.id);
        if (!figmaNode) {
          console.warn(
            `[FigmaImplementation] Node ${node.id} not found for SVG export`,
          );
          return;
        }

        if (
          figmaNode.type === "FRAME" ||
          figmaNode.type === "COMPONENT" ||
          figmaNode.type === "COMPONENT_SET"
        ) {
          const svg = await this.exportFrameNodeSVG(
            figmaNode as FrameNode | ComponentNode | ComponentSetNode,
          );
          if (node.type === "figmaNode") {
            node.data.svg = svg;
          }
        } else if (figmaNode.type === "TEXT") {
          const svg = await this.exportTextNodeSVG(figmaNode as TextNode);
          if (node.type === "textNode") {
            node.data.svg = svg;
          }
        }
      } catch (error) {
        console.error(
          `[FigmaImplementation] Failed to export SVG for node ${node.id}:`,
          error,
        );
      }
    });

    await Promise.all(svgPromises);
  }

  /**
   * Export SVGs for specific node IDs in parallel
   */
  exportNodeSVGs = async (
    nodeIds: string[],
  ): Promise<Array<{ nodeId: string; svg: string | Uint8Array | null }>> => {
    const svgPromises = nodeIds.map(async (nodeId) => {
      try {
        const figmaNode = await figma.getNodeByIdAsync(nodeId);
        if (!figmaNode) {
          console.warn(
            `[FigmaImplementation] Node ${nodeId} not found for SVG export`,
          );
          return { nodeId, svg: null };
        }

        if (
          figmaNode.type === "FRAME" ||
          figmaNode.type === "COMPONENT" ||
          figmaNode.type === "COMPONENT_SET"
        ) {
          const svg = await this.exportFrameNodeSVG(
            figmaNode as FrameNode | ComponentNode | ComponentSetNode,
          );
          return { nodeId, svg };
        } else if (figmaNode.type === "TEXT") {
          const svg = await this.exportTextNodeSVG(figmaNode as TextNode);
          return { nodeId, svg };
        }

        return { nodeId, svg: null };
      } catch (error) {
        console.error(
          `[FigmaImplementation] Failed to export SVG for node ${nodeId}:`,
          error,
        );
        return { nodeId, svg: null };
      }
    });

    return Promise.all(svgPromises);
  };

  currentPage = {
    get selection() {
      return figma.currentPage.selection;
    },
    get children() {
      return figma.currentPage.children;
    },
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
    },
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
    },
  };

  constructor() {
    // Bridge figma.ui.onmessage to our interface
    Object.defineProperty(this.ui, "onmessage", {
      get: () => figma.ui.onmessage,
      set: (handler) => {
        figma.ui.onmessage = handler;
      },
    });
  }
}
