// Import platform abstraction for cross-environment compatibility
// Use direct path since worker bypasses Vite aliases
import { platform } from "@widget/platform";
import {
  CompleteRequest,
  MessageCategory,
  OperationMessageType,
} from "@shared-core/types/messageTypes";

// Wrap in async IIFE to handle top-level await in esbuild IIFE format
(async () => {
  const commands = await platform.getInstance();

  commands.ui.showUI(__html__, {
    height: 500,
    width: 500,
  });

  const { codeMessageDispatcher, setupCodeMessageListener } = await import("@widget/messaging/CodeMessageDispatcher");

  // Initialize the message listener to receive messages from the UI
  setupCodeMessageListener();


  async function handleCompletion({payload: object}: CompleteRequest): Promise<void> {
  let asyncFunctions: Promise<void>[] = [];
  if (!object.id) {
    console.error("Problem happened during completion");
    return;
  }

  let currentFrameNode: FrameNode = await commands.getNodeByIdAsync(object.id) as FrameNode;

  if (!currentFrameNode) {
    currentFrameNode = commands.createFrame();
  }

  const appendFillStyle = async () => {
    if (object.fillStyleId) {
      const fillStyle = await commands.getStyleByIdAsync(object.fillStyleId);
      if (fillStyle) {
        asyncFunctions.push(currentFrameNode.setFillStyleIdAsync(object.fillStyleId));
      }
    }
  };
  asyncFunctions.push(appendFillStyle());

  const appendStrokeStyle = async () => {
    if (object.strokeStyleId) {
      const strokeStyle = await commands.getStyleByIdAsync(object.strokeStyleId);
      if (strokeStyle) {
        asyncFunctions.push(currentFrameNode.setStrokeStyleIdAsync(strokeStyle.id));
      }
    }
  };
  asyncFunctions.push(appendStrokeStyle());

  const appendEffectStyle = async () => {
    if (object.effectStyleId) {
      const effectStyle = await commands.getStyleByIdAsync(object.effectStyleId);
      if (effectStyle) {
        asyncFunctions.push(currentFrameNode.setEffectStyleIdAsync(effectStyle.id));
      }
    }
  };
  asyncFunctions.push(appendEffectStyle());

  const appendToParent = async () => {
    if (object.parent) {
      const parentNode = await commands.getNodeByIdAsync(object.parent) as FrameNode;
      if (parentNode) {
        parentNode.appendChild(currentFrameNode);
      }
    }
  };
  asyncFunctions.push(appendToParent());

  currentFrameNode.x = object.x !== undefined ? object.x : currentFrameNode.x;
  currentFrameNode.y = object.y !== undefined ? object.y : currentFrameNode.y;
  currentFrameNode.rotation = object.rotation !== undefined ? object.rotation : currentFrameNode.rotation;

  const newWidth = object.width !== undefined ? object.width : currentFrameNode.width;
  const newHeight = object.height !== undefined ? object.height : currentFrameNode.height;
  currentFrameNode.resize(newWidth, newHeight);
  currentFrameNode.minWidth = object.minWidth !== undefined ? object.minWidth : currentFrameNode.minWidth;
  currentFrameNode.maxWidth = object.maxWidth !== undefined ? object.maxWidth : currentFrameNode.maxWidth;
  currentFrameNode.minHeight = object.minHeight !== undefined ? object.minHeight : currentFrameNode.minHeight;
  currentFrameNode.maxHeight = object.maxHeight !== undefined ? object.maxHeight : currentFrameNode.maxHeight;

  currentFrameNode.layoutMode = object.layoutMode !== undefined ? object.layoutMode : currentFrameNode.layoutMode;
  currentFrameNode.layoutAlign = object.layoutAlign !== undefined ? object.layoutAlign : currentFrameNode.layoutAlign;
  currentFrameNode.layoutGrow = object.layoutGrow !== undefined ? object.layoutGrow : currentFrameNode.layoutGrow;
  currentFrameNode.primaryAxisSizingMode = object.primaryAxisSizingMode !== undefined ? object.primaryAxisSizingMode : currentFrameNode.primaryAxisSizingMode;
  currentFrameNode.counterAxisSizingMode = object.counterAxisSizingMode !== undefined ? object.counterAxisSizingMode : currentFrameNode.counterAxisSizingMode;
  currentFrameNode.primaryAxisAlignItems = object.primaryAxisAlignItems !== undefined ? object.primaryAxisAlignItems : currentFrameNode.primaryAxisAlignItems;
  currentFrameNode.counterAxisAlignItems = object.counterAxisAlignItems !== undefined ? object.counterAxisAlignItems : currentFrameNode.counterAxisAlignItems;
  currentFrameNode.paddingLeft = object.paddingLeft !== undefined ? object.paddingLeft : currentFrameNode.paddingLeft;
  currentFrameNode.paddingRight = object.paddingRight !== undefined ? object.paddingRight : currentFrameNode.paddingRight;
  currentFrameNode.paddingTop = object.paddingTop !== undefined ? object.paddingTop : currentFrameNode.paddingTop;
  currentFrameNode.paddingBottom = object.paddingBottom !== undefined ? object.paddingBottom : currentFrameNode.paddingBottom;
  currentFrameNode.itemSpacing = object.itemSpacing !== undefined ? object.itemSpacing : currentFrameNode.itemSpacing;

  currentFrameNode.fills = object.fills !== undefined ? object.fills : currentFrameNode.fills;
  currentFrameNode.strokes = object.strokes !== undefined ? object.strokes : currentFrameNode.strokes;
  currentFrameNode.strokeWeight = object.strokeWeight !== undefined ? object.strokeWeight : currentFrameNode.strokeWeight;
  currentFrameNode.strokeAlign = object.strokeAlign !== undefined ? object.strokeAlign : currentFrameNode.strokeAlign;
  currentFrameNode.cornerRadius = object.cornerRadius !== undefined ? object.cornerRadius : currentFrameNode.cornerRadius;
  currentFrameNode.opacity = object.opacity !== undefined ? object.opacity : currentFrameNode.opacity;
  currentFrameNode.blendMode = object.blendMode !== undefined ? object.blendMode : currentFrameNode.blendMode;

  currentFrameNode.effects = object.effects !== undefined ? object.effects : currentFrameNode.effects;

  await Promise.all(asyncFunctions);
}

  // Register the completion handler with the new messaging system
  codeMessageDispatcher.registerHandler(
    MessageCategory.OPERATION,
    OperationMessageType.COMPLETE,
    handleCompletion
  );
})();
