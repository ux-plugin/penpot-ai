import React, { memo, useMemo, useRef, useEffect } from "react";
import type { NodeProps } from "@xyflow/react";
import { Handle as HandleComponent, Position as PositionEnum } from "@xyflow/react";
import type { TextNodeType } from "./node.types";
import {
  convertTextAlignToCSS,
  convertVerticalAlignToCSS,
  parseSVGToElement,
  convertSVGToString,
} from "@utils/figmaStyleConversions";

/**
 * Constants for node styling
 */
const LOCKED_OPACITY = 0.5;
const HIDDEN_OPACITY = 0.3;

/**
 * React Flow Text Node Component
 */
export const ReactFlowTextNode = memo((props: NodeProps<TextNodeType>) => {
  const { data, width, height, positionAbsoluteX, positionAbsoluteY, selected } = props;
  const svgContainerRef = useRef<HTMLDivElement>(null);

  // Parse SVG element if available
  const svgElement = useMemo(() => {
    if (data?.svgElement) {
      return data.svgElement;
    }
    if (data?.svg) {
      return parseSVGToElement(data.svg);
    }
    return null;
  }, [data?.svg, data?.svgElement]);

  // Convert SVG to string for rendering
  const svgString = useMemo(() => {
    if (data?.svg) {
      return convertSVGToString(data.svg);
    }
    return null;
  }, [data?.svg]);

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

  // Render SVG element into container
  useEffect(() => {
    if (svgElement && svgContainerRef.current) {
      // Clear existing content
      svgContainerRef.current.innerHTML = '';
      // Clone and append SVG element
      const clonedSvg = svgElement.cloneNode(true) as SVGElement;
      // Ensure SVG scales to container
      clonedSvg.setAttribute('width', '100%');
      clonedSvg.setAttribute('height', '100%');
      clonedSvg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      svgContainerRef.current.appendChild(clonedSvg);
    }
  }, [svgElement]);

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
    hasSvg: !!svgElement || !!svgString,
  });

  // If SVG is available, render it in a transparent selectable box
  if (svgElement || svgString) {
    return (
      <div
        className="bg-transparent transition-[background-color,border-color] duration-200 ease-in-out border-2 border-transparent rounded hover:bg-blue-500/10 hover:border-blue-500/30 data-[selected=true]:bg-blue-500/15 data-[selected=true]:border-blue-500/50"
        style={{
          width: width,
          height: height,
          opacity: finalOpacity,
          transform: `rotate(${rotation}deg)`,
          pointerEvents: visible ? "auto" : "none",
          position: "relative",
        }}
        data-selected={selected}
        data-stroke-style-id={data?.strokeStyleId}
        data-effect-style-id={data?.effectStyleId}
      >
        <div
          ref={svgContainerRef}
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          dangerouslySetInnerHTML={svgString ? { __html: svgString } : undefined}
        />
        <HandleComponent type="target" position={PositionEnum.Top} style={{ opacity: 0 }} />
        <HandleComponent type="source" position={PositionEnum.Bottom} style={{ opacity: 0 }} />
      </div>
    );
  }

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
        {textContent}
      </div>

      <HandleComponent type="target" position={PositionEnum.Top} style={{ opacity: 0 }} />
      <HandleComponent type="source" position={PositionEnum.Bottom} style={{ opacity: 0 }} />
    </div>
  );
});

ReactFlowTextNode.displayName = "ReactFlowTextNode";
