// Import platform abstraction for cross-environment compatibility
// Use direct path since worker bypasses Vite aliases
import { platform } from "@widget/platform";
import {
  CompleteRequest,
  MessageCategory,
  OperationMessageType,
  SystemMessageType,
} from "@/shared/types/messageTypes";

// ============================================
// TESTING ONLY: Generic Node Logging Function
// ============================================

/**
 * Log detailed information about selected nodes
 * For testing purposes only - Shows fills property and SVG string export
 */
async function logSelectedNodes(commands: any): Promise<void> {
  const selection = commands.currentPage.selection;

  console.log("\n" + "=".repeat(60));
  console.log("NODE SELECTION - FILLS & SVG (Testing)");
  console.log("=".repeat(60));
  console.log(`Selected ${selection.length} node(s)\n`);

  if (selection.length === 0) {
    console.log("No nodes selected");
    console.log("=".repeat(60) + "\n");
    return;
  }

  // Process nodes sequentially to avoid overwhelming the console
  for (let index = 0; index < selection.length; index++) {
    const node: any = selection[index];
    console.log(`\n--- NODE ${index + 1} ---`);
    console.log(`Type: ${node.type}`);
    console.log(`Name: ${node.name}`);
    console.log(`ID: ${node.id}`);

    // Log fills property
    console.log("\nFills:");
    if (typeof node.fills === "symbol") {
      console.log(
        "  Symbol(figma.mixed) - This node has mixed fills (different parts have different colors)",
      );
      console.log("  Raw value:", node.fills);

      // For text nodes with mixed fills, try to get fill segments
      if (
        node.type === "TEXT" &&
        typeof node.getStyledTextSegments === "function"
      ) {
        try {
          const segments = node.getStyledTextSegments([
            "fills",
            "textDecoration",
          ]);
          console.log("  Text segments with different fills:");
          segments.forEach((segment: any, idx: number) => {
            console.log(`    Segment ${idx + 1}:`, segment);
          });
        } catch (e) {
          console.log("  Could not retrieve text segments:", e);
        }
      }
    } else {
      console.log(" ", node);
      // For text nodes with mixed fills, try to get fill segments
      if (
        node.type === "TEXT" &&
        typeof node.getStyledTextSegments === "function"
      ) {
        try {
          const segments = node.getStyledTextSegments([
            "fills",
            "textDecoration",
          ]);
          console.log(segments);
          console.log("  Text segments with different fills:");
          segments.forEach((segment: any, idx: number) => {
            console.log(`    Segment ${idx + 1}:`, segment);
          });
        } catch (e) {
          console.log("  Could not retrieve text segments:", e);
        }
      }
    }

    // Export and log SVG string
    console.log("\nSVG Export:");
    if (typeof node.exportAsync === "function") {
      try {
        const svgString = await node.exportAsync({
          format: "SVG_STRING",
          svgSimplifyStroke: true,
        });
        console.log(`  Node Width: ${node.width}`);
        console.log(`  Node Height: ${node.height}`);
        console.log(`  SVG String Length: ${svgString.length} characters`);
        console.log(
          `  SVG Preview (first 200 chars): ${svgString.substring(0, 200)}...`,
        );
        console.log(`  Full SVG:`);
        console.log(svgString);
      } catch (e) {
        console.log(`  Could not export SVG: ${e}`);
      }
    } else {
      console.log("  Node does not support exportAsync");
    }
  }

  console.log("\n" + "=".repeat(60) + "\n");
}

// ============================================
// END TESTING CODE
// ============================================

// Wrap in async IIFE to handle top-level await in esbuild IIFE format
(async () => {
  const commands = await platform.getInstance();

  commands.ui.showUI(__html__, {
    height: 500,
    width: 500,
  });

  const { codeMessageDispatcher, setupCodeMessageListener } = await import(
    "@widget/CodeMessageDispatcher.ts"
  );

  // Initialize the message listener to receive messages from the UI
  setupCodeMessageListener();

  // ============================================
  // Node Change Tracking: Listen to Figma events and notify UI
  // ============================================

  // Handle page node changes (property changes, creates, deletes)
  // Using PageNode.on("nodechange") as recommended by Figma API
  // See: https://developers.figma.com/docs/plugins/api/properties/PageNode-on/
  commands.currentPage.on("nodechange", async (event: any) => {
    try {
      const nodeChanges = event?.nodeChanges || [];
      if (nodeChanges.length === 0) return;

      // Collect all changed node IDs and categorize changes
      const createdNodeIds: string[] = [];
      const deletedNodeIds: string[] = [];
      const updatedNodeIds: string[] = [];

      for (const change of nodeChanges) {
        if (change.type === "CREATE") {
          const nodeId = change.node?.id;
          if (nodeId) {
            createdNodeIds.push(nodeId);
          }
        } else if (change.type === "DELETE") {
          const nodeId = change.node?.id || change.id;
          if (nodeId) {
            deletedNodeIds.push(nodeId);
          }
        } else if (change.type === "PROPERTY_CHANGE") {
          const nodeId = change.node?.id;
          if (nodeId) {
            updatedNodeIds.push(nodeId);
          }
        }
      }

      // Batch fetch nodes for creates and updates together
      const nodesNeedingFetch = [...createdNodeIds, ...updatedNodeIds];
      let fetchedNodes: any[] = [];
      if (nodesNeedingFetch.length > 0) {
        // Get all nodes and filter to changed ones
        const allNodes = await commands.getAllNodes(false);
        fetchedNodes = allNodes.filter((node) =>
          nodesNeedingFetch.includes(node.id),
        );
      }

      // Handle creates
      if (createdNodeIds.length > 0) {
        const createdNodes = fetchedNodes.filter((node) =>
          createdNodeIds.includes(node.id),
        );

        await codeMessageDispatcher.sendRequest({
          category: MessageCategory.SYSTEM,
          type: SystemMessageType.NODE_CHANGED,
          payload: {
            changeType: "create",
            nodeIds: createdNodeIds,
            nodes: createdNodes,
          },
        });
      }

      // Handle deletes
      if (deletedNodeIds.length > 0) {
        await codeMessageDispatcher.sendRequest({
          category: MessageCategory.SYSTEM,
          type: SystemMessageType.NODE_CHANGED,
          payload: {
            changeType: "delete",
            nodeIds: deletedNodeIds,
          },
        });
      }

      // Handle property updates
      if (updatedNodeIds.length > 0) {
        const updatedNodes = fetchedNodes.filter((node) =>
          updatedNodeIds.includes(node.id),
        );

        await codeMessageDispatcher.sendRequest({
          category: MessageCategory.SYSTEM,
          type: SystemMessageType.NODE_CHANGED,
          payload: {
            changeType: "property",
            nodeIds: updatedNodeIds,
            nodes: updatedNodes,
          },
        });
      }
    } catch (error) {
      console.error("[code.ts] Error handling nodechange:", error);
    }
  });

  // Handle selection changes
  commands.on("selectionchange", async () => {
    try {
      const selectedIds = commands.currentPage.selection.map(
        (node: any) => node.id,
      );

      await codeMessageDispatcher.sendRequest({
        category: MessageCategory.SYSTEM,
        type: SystemMessageType.SELECTION_CHANGED,
        payload: {
          selectedNodeIds: selectedIds,
        },
      });
    } catch (error) {
      console.error("[code.ts] Error handling selectionchange:", error);
    }
  });

  // ============================================
  // TESTING ONLY: Setup selection change listener
  // ============================================
  // Keep the testing code but wrap it to avoid conflicts
  const originalSelectionChange = async () => {
    await logSelectedNodes(commands);
  };

  // Log initial selection
  console.log("Selection logging initialized (Testing Mode)");
  await originalSelectionChange();
  // ============================================

  async function handleCompletion({
    payload: object,
  }: CompleteRequest): Promise<void> {
    let asyncFunctions: Promise<void>[] = [];
    if (!object.id) {
      console.error("Problem happened during completion");
      return;
    }

    let currentFrameNode: FrameNode = (await commands.getNodeByIdAsync(
      object.id,
    )) as FrameNode;

    if (!currentFrameNode) {
      currentFrameNode = commands.createFrame();
    }

    const appendFillStyle = async () => {
      if (object.fillStyleId) {
        const fillStyle = await commands.getStyleByIdAsync(object.fillStyleId);
        if (fillStyle) {
          asyncFunctions.push(
            currentFrameNode.setFillStyleIdAsync(object.fillStyleId),
          );
        }
      }
    };
    asyncFunctions.push(appendFillStyle());

    const appendStrokeStyle = async () => {
      if (object.strokeStyleId) {
        const strokeStyle = await commands.getStyleByIdAsync(
          object.strokeStyleId,
        );
        if (strokeStyle) {
          asyncFunctions.push(
            currentFrameNode.setStrokeStyleIdAsync(strokeStyle.id),
          );
        }
      }
    };
    asyncFunctions.push(appendStrokeStyle());

    const appendEffectStyle = async () => {
      if (object.effectStyleId) {
        const effectStyle = await commands.getStyleByIdAsync(
          object.effectStyleId,
        );
        if (effectStyle) {
          asyncFunctions.push(
            currentFrameNode.setEffectStyleIdAsync(effectStyle.id),
          );
        }
      }
    };
    asyncFunctions.push(appendEffectStyle());

    const appendToParent = async () => {
      if (object.parent) {
        const parentNode = (await commands.getNodeByIdAsync(
          object.parent,
        )) as FrameNode;
        if (parentNode) {
          parentNode.appendChild(currentFrameNode);
        }
      }
    };
    asyncFunctions.push(appendToParent());

    currentFrameNode.x = object.x !== undefined ? object.x : currentFrameNode.x;
    currentFrameNode.y = object.y !== undefined ? object.y : currentFrameNode.y;
    currentFrameNode.rotation =
      object.rotation !== undefined
        ? object.rotation
        : currentFrameNode.rotation;

    const newWidth =
      object.width !== undefined ? object.width : currentFrameNode.width;
    const newHeight =
      object.height !== undefined ? object.height : currentFrameNode.height;
    currentFrameNode.resize(newWidth, newHeight);
    currentFrameNode.minWidth =
      object.minWidth !== undefined
        ? object.minWidth
        : currentFrameNode.minWidth;
    currentFrameNode.maxWidth =
      object.maxWidth !== undefined
        ? object.maxWidth
        : currentFrameNode.maxWidth;
    currentFrameNode.minHeight =
      object.minHeight !== undefined
        ? object.minHeight
        : currentFrameNode.minHeight;
    currentFrameNode.maxHeight =
      object.maxHeight !== undefined
        ? object.maxHeight
        : currentFrameNode.maxHeight;

    currentFrameNode.layoutMode =
      object.layoutMode !== undefined
        ? object.layoutMode
        : currentFrameNode.layoutMode;
    currentFrameNode.layoutAlign =
      object.layoutAlign !== undefined
        ? object.layoutAlign
        : currentFrameNode.layoutAlign;
    currentFrameNode.layoutGrow =
      object.layoutGrow !== undefined
        ? object.layoutGrow
        : currentFrameNode.layoutGrow;
    currentFrameNode.primaryAxisSizingMode =
      object.primaryAxisSizingMode !== undefined
        ? object.primaryAxisSizingMode
        : currentFrameNode.primaryAxisSizingMode;
    currentFrameNode.counterAxisSizingMode =
      object.counterAxisSizingMode !== undefined
        ? object.counterAxisSizingMode
        : currentFrameNode.counterAxisSizingMode;
    currentFrameNode.primaryAxisAlignItems =
      object.primaryAxisAlignItems !== undefined
        ? object.primaryAxisAlignItems
        : currentFrameNode.primaryAxisAlignItems;
    currentFrameNode.counterAxisAlignItems =
      object.counterAxisAlignItems !== undefined
        ? object.counterAxisAlignItems
        : currentFrameNode.counterAxisAlignItems;
    currentFrameNode.paddingLeft =
      object.paddingLeft !== undefined
        ? object.paddingLeft
        : currentFrameNode.paddingLeft;
    currentFrameNode.paddingRight =
      object.paddingRight !== undefined
        ? object.paddingRight
        : currentFrameNode.paddingRight;
    currentFrameNode.paddingTop =
      object.paddingTop !== undefined
        ? object.paddingTop
        : currentFrameNode.paddingTop;
    currentFrameNode.paddingBottom =
      object.paddingBottom !== undefined
        ? object.paddingBottom
        : currentFrameNode.paddingBottom;
    currentFrameNode.itemSpacing =
      object.itemSpacing !== undefined
        ? object.itemSpacing
        : currentFrameNode.itemSpacing;

    currentFrameNode.fills =
      object.fills !== undefined ? object.fills : currentFrameNode.fills;
    currentFrameNode.strokes =
      object.strokes !== undefined ? object.strokes : currentFrameNode.strokes;
    currentFrameNode.strokeWeight =
      object.strokeWeight !== undefined
        ? object.strokeWeight
        : currentFrameNode.strokeWeight;
    currentFrameNode.strokeAlign =
      object.strokeAlign !== undefined
        ? object.strokeAlign
        : currentFrameNode.strokeAlign;
    currentFrameNode.cornerRadius =
      object.cornerRadius !== undefined
        ? object.cornerRadius
        : currentFrameNode.cornerRadius;
    currentFrameNode.opacity =
      object.opacity !== undefined ? object.opacity : currentFrameNode.opacity;
    currentFrameNode.blendMode =
      object.blendMode !== undefined
        ? object.blendMode
        : currentFrameNode.blendMode;

    currentFrameNode.effects =
      object.effects !== undefined ? object.effects : currentFrameNode.effects;

    await Promise.all(asyncFunctions);
  }

  // Register the completion handler with the new messaging system
  codeMessageDispatcher.registerHandler(
    MessageCategory.OPERATION,
    OperationMessageType.COMPLETE,
    handleCompletion,
  );
})();
