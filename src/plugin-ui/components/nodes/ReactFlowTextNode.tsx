import React, { memo, useEffect, useRef } from "react";
import type { NodeProps } from "@xyflow/react";
import { Handle as HandleComponent, Position as PositionEnum } from "@xyflow/react";
import type { TextNodeType } from "./node.types";
import { convertTextAlignToCSS, convertVerticalAlignToCSS } from "@utils/figmaStyleConversions";

/**
 * Constants for node styling
 */
const LOCKED_OPACITY = 0.5;
const HIDDEN_OPACITY = 0.3;

/**
 * React Flow Text Node Component
 */
export const ReactFlowTextNode = memo((props: NodeProps<TextNodeType>) => {
  const { data, width, height, positionAbsoluteX, positionAbsoluteY } = props;

  // This ref is for a real DOM <div>. Don't assign to .current manually.
  const svgContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = svgContainerRef.current;
    if (!container) return;

    // Clear previous SVG content
    container.replaceChildren();

    const svg = data?.svgElement;
    if (!svg) return;

    // Append a clone so we don't "move" the same SVG node between React nodes.
    container.appendChild(svg.cloneNode(true));
  }, [data?.svgElement]);

  // Basic properties
  const locked = data?.locked ?? false;
  const visible = data?.visible ?? true;
  const baseOpacity = data?.opacity ?? 1;
  const rotation = data?.rotation ?? 0;
  const label = data?.label ?? "";
  const name = data?.name ?? label;

  // Text content (prefer text, fallback to characters)
  const textContent = data?.text ?? data?.characters ?? "";

  // Text alignment
  const textAlign = convertTextAlignToCSS(data?.textAlignHorizontal);
  const verticalAlign = convertVerticalAlignToCSS(data?.textAlignVertical);

  // Calculate final opacity based on visibility and locked state
  const finalOpacity = !visible ? HIDDEN_OPACITY : locked ? LOCKED_OPACITY : baseOpacity;

  // Rich text segments
  const hasSegments = data?.segments && data.segments.length > 0;

  console.log(`[ReactFlowTextNode] Rendering text node "${label}" at position:`, {
    x: positionAbsoluteX,
    y: positionAbsoluteY,
    label,
    name,
    visible,
    locked,
    opacity: finalOpacity,
    rotation,
    textAlign,
    verticalAlign,
    hasSegments,
    segmentCount: data?.segments?.length ?? 0,
    text: textContent.substring(0, 50) + (textContent.length > 50 ? "..." : ""),
  });

  return (
    <div
      style={{
        width: width,
        height: height,
        opacity: finalOpacity,
        transform: `rotate(${rotation}deg)`,
        pointerEvents: visible ? "auto" : "none",
        display: "flex",
        flexDirection: "column",
        justifyContent: verticalAlign,
        position: "relative",
      }}
      data-stroke-style-id={data?.strokeStyleId}
      data-effect-style-id={data?.effectStyleId}
    >
      {/* Render rich text segments or plain text */}
      <div
        style={
          {
            textAlign: textAlign,
          } as React.CSSProperties
        }
      >
        {/* Render SVG if available, otherwise show text content */}
        {data?.svgElement ? (
          <div ref={svgContainerRef} />
        ) : (
          <>
            {/*{hasSegments*/}
            {/*  ? data.segments!.map((segment, index) => renderStyledSegment(segment, index, strokeColor, strokeWeight, boxShadow, filter, blendMode))*/}
            {/*  : textContent*/}
            {/*}*/}
            {textContent}
          </>
        )}
      </div>

      <HandleComponent type="target" position={PositionEnum.Top} style={{ opacity: 0 }} />
      <HandleComponent type="source" position={PositionEnum.Bottom} style={{ opacity: 0 }} />
    </div>
  );
});

ReactFlowTextNode.displayName = "ReactFlowTextNode";
