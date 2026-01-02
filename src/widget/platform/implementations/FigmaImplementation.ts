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

        // Children - empty array, children are processed recursively and added to flat array with parentId
        children: [],
      },
      width: frameNode.width,
      height: frameNode.height,
      draggable: false,
      selectable: false,
    };
  }

  /**
   * Export SVG for a FrameNode, ComponentNode, ComponentSetNode, GroupNode, or InstanceNode
   * Optimized with svgSimplifyStroke for faster export performance
   */
  private async exportFrameNodeSVG(
    frameNode:
      | FrameNode
      | ComponentNode
      | ComponentSetNode
      | GroupNode
      | InstanceNode,
  ): Promise<Uint8Array> {
    const svg = await frameNode.exportAsync({
      format: "SVG",
      svgSimplifyStroke: true, // Simplifies strokes for faster export
    });
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
    const svg = await textNode.exportAsync({
      format: "SVG_STRING",
      svgOutlineText: true,
    });
    return svg;
  }

  /**
   * Get all nodes (frames, components, texts, groups, instances) from the current page recursively
   * Extracts basic properties first (without SVG) for faster initial rendering
   * Recursively traverses all child nodes maintaining a flat array structure with parentId references
   */
  getAllNodes = async (includeSVG: boolean = false): Promise<DesignNode[]> => {
    const nodes: DesignNode[] = [];
    const currentPageChildren = figma.currentPage.children;

    // First pass: Extract all basic properties (fast, synchronous)
    this.transformNodesToDesignNodesBasic(currentPageChildren, nodes);

    // Second pass: Propagate rendering modes through the tree
    this.propagateRenderingModes(nodes);

    // Third pass: Export SVGs in parallel if requested
    if (includeSVG) {
      await this.addSVGsToNodes(nodes);
    }

    return nodes;
  };

  /**
   * Transform nodes to DesignNodes with basic properties only (no SVG)
   * Recursively processes all children of nodes that can contain other nodes
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
        // Add the frame/component to the flat array
        const extractedNode = this.extractFrameNodeBasicProperties(
          frameNode,
          parentId,
        );
        nodes.push(extractedNode);

        // Recursively process children if they exist
        if (frameNode.children && frameNode.children.length > 0) {
          this.transformNodesToDesignNodesBasic(
            frameNode.children,
            nodes,
            frameNode.id,
          );
        }
      } else if (child.type === "TEXT") {
        // Add the text node to the flat array
        nodes.push(
          this.extractTextNodeBasicProperties(child as TextNode, parentId),
        );
      } else if (child.type === "GROUP" || child.type === "INSTANCE") {
        // Handle GROUP and INSTANCE nodes - they can have children but may not have all frame properties
        // For now, we'll extract basic properties similar to frames
        const groupOrInstanceNode = child as GroupNode | InstanceNode;

        // Extract basic properties (similar to frames but simplified)
        const extractedNode: ReactFlowFrameNodeType = {
          id: groupOrInstanceNode.id,
          type: "figmaNode",
          parentId: parentId,
          position: {
            x: groupOrInstanceNode.x,
            y: groupOrInstanceNode.y,
          },
          data: {
            label: groupOrInstanceNode.name,
            name: groupOrInstanceNode.name,
            locked: groupOrInstanceNode.locked,
            visible: groupOrInstanceNode.visible,
            opacity: groupOrInstanceNode.opacity,
            rotation: groupOrInstanceNode.rotation,
            nodeType:
              groupOrInstanceNode.type === "GROUP" ? "FRAME" : "COMPONENT", // Map to closest type

            // Dimensions
            width: groupOrInstanceNode.width,
            height: groupOrInstanceNode.height,

            // Basic style properties (groups/instances may not have all frame properties)
            fills: (groupOrInstanceNode as any).fills as
              | ReadonlyArray<Paint>
              | undefined,
            strokes: (groupOrInstanceNode as any).strokes as
              | ReadonlyArray<Paint>
              | undefined,
            blendMode: groupOrInstanceNode.blendMode,
            effects: (groupOrInstanceNode as any).effects as
              | ReadonlyArray<Effect>
              | undefined,

            children: [],
          },
          width: groupOrInstanceNode.width,
          height: groupOrInstanceNode.height,
          draggable: false,
          selectable: false,
        };

        nodes.push(extractedNode);

        // Recursively process children if they exist
        if (
          groupOrInstanceNode.children &&
          groupOrInstanceNode.children.length > 0
        ) {
          this.transformNodesToDesignNodesBasic(
            groupOrInstanceNode.children,
            nodes,
            groupOrInstanceNode.id,
          );
        }
      }
      // Note: Other node types (RECTANGLE, ELLIPSE, etc.) don't have children, so we skip them
    }
  }

  /**
   * Propagates rendering modes through the node tree
   * Rules:
   * - SVG parent → all descendants become bounding-box
   * - CSS parent → children can be CSS or SVG based on their complexity
   * - Root nodes → determined by their own complexity
   */
  private propagateRenderingModes(nodes: DesignNode[]): void {
    // Build parent-child map and node map
    const childrenMap = new Map<string, DesignNode[]>();
    const nodeMap = new Map<string, DesignNode>();

    // Index all nodes
    for (const node of nodes) {
      nodeMap.set(node.id, node);
      if (node.parentId) {
        if (!childrenMap.has(node.parentId)) {
          childrenMap.set(node.parentId, []);
        }
        childrenMap.get(node.parentId)!.push(node);
      }
    }

    // Process root nodes (nodes without parentId)
    const processNode = (
      node: DesignNode,
      parentMode: "css" | "svg" | "bounding-box" | null,
    ): void => {
      // Determine rendering mode based on parent
      if (parentMode === "svg") {
        // If parent uses SVG, this node and all descendants become bounding boxes
        if (node.type === "figmaNode") {
          node.data.renderMode = "bounding-box";
        } else if (node.type === "textNode") {
          node.data.renderMode = "bounding-box";
        }
      } else {
        // Text nodes always need SVG for accurate text rendering
        if (node.type === "textNode") {
          node.data.renderMode = "svg";
        } else if (node.type === "figmaNode") {
          // For frame nodes, determine based on complexity
          if (parentMode === "css") {
            // If parent uses CSS, child can be CSS or SVG based on complexity
            node.data.renderMode = this.shouldExportSVG(node) ? "svg" : "css";
          } else {
            // Root node - determine based on complexity
            node.data.renderMode = this.shouldExportSVG(node) ? "svg" : "css";
          }
        }
      }

      // Get current node's renderMode
      const currentMode = (
        node.type === "figmaNode"
          ? node.data.renderMode
          : node.type === "textNode"
            ? node.data.renderMode
            : "css"
      ) as "css" | "svg" | "bounding-box";

      // Process children recursively
      const children = childrenMap.get(node.id) || [];
      for (const child of children) {
        processNode(child, currentMode);
      }
    };

    // Start processing from root nodes
    for (const node of nodes) {
      if (!node.parentId) {
        processNode(node, null);
      }
    }
  }

  /**
   * Determines if a node requires SVG export based on its complexity
   * Simple nodes can be rendered with CSS, complex nodes need SVG
   */
  private shouldExportSVG(node: DesignNode): boolean {
    if (node.type !== "figmaNode") {
      // Text nodes always need SVG for accurate rendering
      return true;
    }

    const data = node.data;

    // Components and component sets always need SVG for pixel-perfect rendering
    if (data.nodeType === "COMPONENT" || data.nodeType === "COMPONENT_SET") {
      return true;
    }

    // Check for gradients in fills
    if (data.fills && data.fills.length > 0) {
      const hasGradients = data.fills.some(
        (fill) =>
          fill.type === "GRADIENT_LINEAR" ||
          fill.type === "GRADIENT_RADIAL" ||
          fill.type === "GRADIENT_ANGULAR" ||
          fill.type === "GRADIENT_DIAMOND" ||
          fill.type === "IMAGE",
      );
      if (hasGradients) {
        return true;
      }
    }

    // Check for complex effects (blurs, multiple shadows)
    if (data.effects && data.effects.length > 0) {
      const hasComplexEffects = data.effects.some((effect) => {
        if (!effect.visible) return false;
        // Blurs require SVG
        if (effect.type === "LAYER_BLUR" || effect.type === "BACKGROUND_BLUR") {
          return true;
        }
        return false;
      });

      // If more than one shadow, prefer SVG
      const shadowCount = data.effects.filter(
        (e) =>
          e.visible && (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW"),
      ).length;
      if (shadowCount > 1 || hasComplexEffects) {
        return true;
      }
    }

    // Check for blend modes (non-normal ones need SVG)
    if (
      data.blendMode &&
      data.blendMode !== "NORMAL" &&
      data.blendMode !== "PASS_THROUGH"
    ) {
      return true;
    }

    // Check for complex stroke (non-uniform stroke weight)
    if (data.strokeWeight) {
      const { top, right, bottom, left } = data.strokeWeight;
      const isUniform = top === right && right === bottom && bottom === left;
      if (!isUniform && data.strokes && data.strokes.length > 0) {
        return true;
      }
    }

    // Default: simple node, can use CSS
    return false;
  }

  /**
   * Add SVGs to nodes in parallel
   * Only exports SVGs for nodes with renderMode === 'svg'
   * Nodes with renderMode === 'css' or 'bounding-box' are skipped
   */
  private async addSVGsToNodes(nodes: DesignNode[]): Promise<void> {
    // Filter to only nodes that need SVG export (renderMode === 'svg')
    const nodesNeedingSVG = nodes.filter((node) => {
      if (node.type === "figmaNode") {
        return node.data.renderMode === "svg";
      } else if (node.type === "textNode") {
        return node.data.renderMode === "svg";
      }
      return false;
    });

    if (nodesNeedingSVG.length === 0) {
      console.log("[SVG Export] No nodes need SVG export");
      return;
    }

    const nodesUsingCSS = nodes.filter((node) => {
      if (node.type === "figmaNode") {
        return node.data.renderMode === "css";
      } else if (node.type === "textNode") {
        return node.data.renderMode === "css";
      }
      return false;
    });

    const nodesUsingBoundingBox = nodes.filter((node) => {
      if (node.type === "figmaNode") {
        return node.data.renderMode === "bounding-box";
      } else if (node.type === "textNode") {
        return node.data.renderMode === "bounding-box";
      }
      return false;
    });

    console.log(
      `[SVG Export] ${nodesNeedingSVG.length} nodes need SVG export, ${nodesUsingCSS.length} nodes will use CSS rendering, ${nodesUsingBoundingBox.length} nodes will use bounding-box rendering`,
    );

    // Only export SVG for nodes that need it
    const svgPromises = nodesNeedingSVG.map(async (node) => {
      const nodeExportStartTime = Date.now();
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
          figmaNode.type === "COMPONENT_SET" ||
          figmaNode.type === "GROUP" ||
          figmaNode.type === "INSTANCE"
        ) {
          // All container node types can be exported as SVG
          const svg = await this.exportFrameNodeSVG(
            figmaNode as
              | FrameNode
              | ComponentNode
              | ComponentSetNode
              | GroupNode
              | InstanceNode,
          );
          const nodeExportEndTime = Date.now();
          const nodeExportDuration = nodeExportEndTime - nodeExportStartTime;
          console.log(
            `[SVG Export] Top-level frame node "${figmaNode.name}" (${figmaNode.id}): ${nodeExportDuration.toFixed(2)}ms`,
          );
          if (node.type === "figmaNode") {
            node.data.svg = svg;
          }
        } else if (figmaNode.type === "TEXT") {
          const svg = await this.exportTextNodeSVG(figmaNode as TextNode);
          const nodeExportEndTime = Date.now();
          const nodeExportDuration = nodeExportEndTime - nodeExportStartTime;
          console.log(
            `[SVG Export] Top-level text node "${figmaNode.name}" (${figmaNode.id}): ${nodeExportDuration.toFixed(2)}ms`,
          );
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
   * Only exports SVGs for top-level nodes (nodes whose parent is the current page) that require SVG rendering
   */
  exportNodeSVGs = async (
    nodeIds: string[],
  ): Promise<Array<{ nodeId: string; svg: string | Uint8Array | null }>> => {
    // Filter to only export the specific node "378:7305"
    nodeIds = nodeIds.filter((nodeId) => nodeId === "302:2446");

    // Filter to only top-level nodes (nodes whose parent is the current page)
    const topLevelNodeIds: string[] = [];
    const nodeIdChecks = nodeIds.map(async (nodeId) => {
      try {
        const figmaNode = await figma.getNodeByIdAsync(nodeId);
        if (!figmaNode) {
          return false;
        }
        // Top-level nodes have the current page as their parent
        return figmaNode.parent === figma.currentPage;
      } catch (error) {
        return false;
      }
    });

    const isTopLevelResults = await Promise.all(nodeIdChecks);
    nodeIds.forEach((nodeId, index) => {
      if (isTopLevelResults[index]) {
        topLevelNodeIds.push(nodeId);
      }
    });

    if (topLevelNodeIds.length === 0) {
      console.log("[SVG Export] No top-level nodes to export");
      return nodeIds.map((nodeId) => ({ nodeId, svg: null }));
    }

    // Check which nodes need SVG export based on complexity
    const nodesNeedingSVG: string[] = [];
    const nodeComplexityChecks = topLevelNodeIds.map(async (nodeId) => {
      try {
        const figmaNode = await figma.getNodeByIdAsync(nodeId);
        if (!figmaNode) {
          return { nodeId, needsSVG: false };
        }

        // Check complexity based on node type
        if (
          figmaNode.type === "FRAME" ||
          figmaNode.type === "COMPONENT" ||
          figmaNode.type === "COMPONENT_SET" ||
          figmaNode.type === "INSTANCE"
        ) {
          const frameNode = figmaNode as
            | FrameNode
            | ComponentNode
            | ComponentSetNode
            | InstanceNode;

          // Check for complexity indicators
          const hasGradients = (frameNode.fills as readonly Paint[])?.some(
            (fill) =>
              fill.type === "GRADIENT_LINEAR" ||
              fill.type === "GRADIENT_RADIAL" ||
              fill.type === "GRADIENT_ANGULAR" ||
              fill.type === "GRADIENT_DIAMOND" ||
              fill.type === "IMAGE",
          );

          const hasComplexEffects = frameNode.effects?.some((effect) => {
            if (!effect.visible) return false;
            return (
              effect.type === "LAYER_BLUR" || effect.type === "BACKGROUND_BLUR"
            );
          });

          const shadowCount =
            frameNode.effects?.filter(
              (e) =>
                e.visible &&
                (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW"),
            ).length || 0;

          const hasBlendMode =
            frameNode.blendMode &&
            frameNode.blendMode !== "NORMAL" &&
            frameNode.blendMode !== "PASS_THROUGH";

          const isComponent =
            figmaNode.type === "COMPONENT" ||
            figmaNode.type === "COMPONENT_SET";

          const needsSVG =
            hasGradients ||
            hasComplexEffects ||
            shadowCount > 1 ||
            hasBlendMode ||
            isComponent ||
            (frameNode.children && frameNode.children.length >= 10);

          return { nodeId, needsSVG };
        } else if (figmaNode.type === "GROUP") {
          // Groups are generally simple, but check children count
          const groupNode = figmaNode as GroupNode;
          const needsSVG =
            groupNode.children && groupNode.children.length >= 10;
          return { nodeId, needsSVG };
        } else if (figmaNode.type === "TEXT") {
          // Text nodes always need SVG for accurate rendering
          return { nodeId, needsSVG: true };
        }

        return { nodeId, needsSVG: false };
      } catch (error) {
        return { nodeId, needsSVG: false };
      }
    });

    const complexityResults = await Promise.all(nodeComplexityChecks);
    complexityResults.forEach(({ nodeId, needsSVG }) => {
      if (needsSVG) {
        nodesNeedingSVG.push(nodeId);
      }
    });

    console.log(
      `[SVG Export] ${nodesNeedingSVG.length} nodes need SVG export out of ${topLevelNodeIds.length} top-level nodes`,
    );

    const svgPromises = nodesNeedingSVG.map(async (nodeId) => {
      const nodeExportStartTime = Date.now();
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
          figmaNode.type === "COMPONENT_SET" ||
          figmaNode.type === "GROUP" ||
          figmaNode.type === "INSTANCE"
        ) {
          const svg = await this.exportFrameNodeSVG(
            figmaNode as
              | FrameNode
              | ComponentNode
              | ComponentSetNode
              | GroupNode
              | InstanceNode,
          );
          const nodeExportEndTime = Date.now();
          const nodeExportDuration = nodeExportEndTime - nodeExportStartTime;
          console.log(
            `[SVG Export] Top-level frame node "${figmaNode.name}" (${figmaNode.id}): ${nodeExportDuration.toFixed(2)}ms`,
          );
          return { nodeId, svg };
        } else if (figmaNode.type === "TEXT") {
          const svg = await this.exportTextNodeSVG(figmaNode as TextNode);
          const nodeExportEndTime = Date.now();
          const nodeExportDuration = nodeExportEndTime - nodeExportStartTime;
          console.log(
            `[SVG Export] Top-level text node "${figmaNode.name}" (${figmaNode.id}): ${nodeExportDuration.toFixed(2)}ms`,
          );
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

    const results = await Promise.all(svgPromises);

    // Return results for all requested nodeIds, with null for non-top-level nodes
    const resultMap = new Map(results.map((r) => [r.nodeId, r.svg]));
    return nodeIds.map((nodeId) => ({
      nodeId,
      svg: resultMap.get(nodeId) ?? null,
    }));
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
