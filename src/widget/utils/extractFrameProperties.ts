interface FrameProperties {
  id: string;
  name: string;
  type: string;
  visible: boolean;
  locked: boolean;

  // Position and size
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;

  // Layout properties
  layoutMode: string;
  layoutAlign: string;
  layoutGrow: number;
  primaryAxisSizingMode: string;
  counterAxisSizingMode: string;
  primaryAxisAlignItems: string;
  counterAxisAlignItems: string;
  paddingLeft: number;
  paddingRight: number;
  paddingTop: number;
  paddingBottom: number;
  itemSpacing: number;

  // Style properties
  fills: symbol | ReadonlyArray<Paint>;
  strokes: ReadonlyArray<Paint>;
  strokeWeight: number | symbol;
  strokeAlign: string;
  cornerRadius: number | PluginAPI["mixed"];
  opacity: number;
  blendMode: BlendMode;

  // Style IDs
  fillStyleId: string | symbol;
  strokeStyleId: string;
  effectStyleId: string;

  // Effects and other styles
  effects: ReadonlyArray<Effect>;

  // Children
  children: FrameProperties[];
}

export function getAllFrameProperties(frameNode: FrameNode): FrameProperties {
  const frameProperties: FrameProperties = {
    id: frameNode.id,
    name: frameNode.name,
    type: frameNode.type,
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

    // Effects and other styles
    effects: frameNode.effects,

    // Initialize an empty children array
    children: [],
  };

  // Recursively get properties of all children frames
  frameNode.children.forEach((child) => {
    if (child.type === "FRAME") {
      frameProperties.children.push(getAllFrameProperties(child as FrameNode));
    }
  });

  return frameProperties;
}
