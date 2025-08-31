// This plugin will open a window to prompt the user to enter a number, and
// it will then create that many rectangles on the screen.
// This file holds the main code for plugins. Code in this file has access to
// the *figma document* via the figma global object.
// You can access browser APIs in the <script> tag inside "ui.html" which has a
// full browser environment (See https://www.figma.com/plugin-docs/how-plugins-run).

import { getAllFrameProperties } from "@/lib/extractFrameProperties";
import { CompletionRequest, MessageType, Request } from "@/types.ts";
import { storageService } from "@/widget/handleStorage.ts";


// This shows the HTML page in "ui.html".
figma.showUI(__html__, {
  height: 500,
  width: 500,
});

async function handleCompletion({object}: CompletionRequest) {
  let asyncFunctions: Promise<void>[] = [];
  if (!object.id) {
    console.error("Problem happened during completion");
    return;
  }

  let currentFrameNode: FrameNode = await figma.getNodeByIdAsync(object.id) as FrameNode;

  if (!currentFrameNode) {
    currentFrameNode = figma.createFrame();
  }

  const appendFillStyle = async () => {
    if (object.fillStyleId) {
      const fillStyle = await figma.getStyleByIdAsync(object.fillStyleId);
      if (fillStyle) {
        asyncFunctions.push(currentFrameNode.setFillStyleIdAsync(object.fillStyleId));
      }
    }
  };
  asyncFunctions.push(appendFillStyle());

  const appendStrokeStyle = async () => {
    if (object.strokeStyleId) {
      const strokeStyle = await figma.getStyleByIdAsync(object.strokeStyleId);
      if (strokeStyle) {
        asyncFunctions.push(currentFrameNode.setStrokeStyleIdAsync(strokeStyle.id));
      }
    }
  };
  asyncFunctions.push(appendStrokeStyle());

  const appendEffectStyle = async () => {
    if (object.effectStyleId) {
      const effectStyle = await figma.getStyleByIdAsync(object.effectStyleId);
      if (effectStyle) {
        asyncFunctions.push(currentFrameNode.setEffectStyleIdAsync(effectStyle.id));
      }
    }
  };
  asyncFunctions.push(appendEffectStyle());

  const appendToParent = async () => {
    if (object.parent) {
      const parentNode = await figma.getNodeByIdAsync(object.parent) as FrameNode;
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

// posted message.
figma.ui.onmessage = async(msg: Request) => {
  switch (msg.type) {
    case MessageType.complete:
      await handleCompletion(msg);
      break;

    case MessageType.storageSave:
      await storageService.handleStorageSave(msg);
      break;
    case MessageType.storageRemove:
      await storageService.handleStorageRemove(msg);
      break;
    case MessageType.storageGet:
      await storageService.handleStorageGet(msg);
      break;

    case MessageType.close:
      figma.closePlugin();
      break;
  }

};

figma.on("selectionchange", () => {
  const selectedFrame = figma.currentPage.selection[0];
  if (selectedFrame.type === "FRAME") {
    const frameWithChildren = getAllFrameProperties(selectedFrame);

    // If you need to send the data somewhere (like to the UI)
    figma.ui.postMessage({
      type: "node-selected",
      data: frameWithChildren,
    });
  }
});
