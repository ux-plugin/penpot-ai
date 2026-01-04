import { useState, useEffect, useRef } from "react";
import { useReactFlow } from "@xyflow/react";
import { uiMessageDispatcher } from "@/plugin-ui/UIMessageDispatcher";
import {
  ExtractResultType,
  MessageCategory,
  ExportNodeSVGsResponse,
  SystemMessageType,
} from "@shared-types/messageTypes";
import { parseSVGToElement } from "@utils/figmaStyleConversions";
import type { DesignNode } from "@shared-types/types";

/**
 * Hook for lazy loading SVG for a ReactFlow node
 * Requests SVG from backend when renderMode is 'svg' and no SVG exists
 * Updates the node data when SVG is received
 *
 * @param nodeId - The ID of the node
 * @param renderMode - The rendering mode of the node ('css' | 'svg' | 'bounding-box')
 * @param hasSVG - Whether the node already has SVG data
 * @returns Object with isLoading state
 */
export function useLazySVG(
  nodeId: string,
  renderMode: "css" | "svg" | "bounding-box" | undefined,
  hasSVG: boolean,
): { isLoading: boolean; error: Error | null } {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const hasRequestedRef = useRef(false);
  const { updateNode } = useReactFlow();

  useEffect(() => {
    // Only request SVG if:
    // 1. renderMode is 'svg'
    // 2. Node doesn't have SVG yet
    // 3. We haven't already requested it
    if (
      renderMode === "svg" &&
      !hasSVG &&
      !hasRequestedRef.current &&
      !isLoading
    ) {
      hasRequestedRef.current = true;
      setIsLoading(true);
      setError(null);

      const requestSVG = async () => {
        try {
          console.log(`[useLazySVG] Requesting SVG for node ${nodeId}`);

          const result = await uiMessageDispatcher.sendRequest<
            Omit<any, "id" | "timestamp" | "source">,
            ExtractResultType<ExportNodeSVGsResponse>
          >({
            category: MessageCategory.SYSTEM,
            type: SystemMessageType.EXPORT_NODE_SVGS,
            payload: {
              nodeIds: [nodeId],
            },
          });

          const svgResult = result.svgs.find((s) => s.nodeId === nodeId);

          if (svgResult && svgResult.svg !== null) {
            // Update the node with SVG data
            updateNode(nodeId, (node) => {
              const designNode = node as DesignNode;
              const updatedData = {
                ...designNode.data,
                svg: svgResult.svg,
              };

              // Parse SVG element if it's a string
              if (typeof svgResult.svg === "string") {
                updatedData.svgElement =
                  parseSVGToElement(svgResult.svg) ?? undefined;
              } else if (svgResult.svg instanceof Uint8Array) {
                // Convert Uint8Array to string for text nodes
                const decoder = new TextDecoder("utf-8");
                const svgString = decoder.decode(svgResult.svg);
                updatedData.svg = svgString;
                updatedData.svgElement =
                  parseSVGToElement(svgString) ?? undefined;
              }

              return {
                ...designNode,
                data: updatedData,
              };
            });

            console.log(
              `[useLazySVG] Successfully loaded SVG for node ${nodeId}`,
            );
          } else {
            console.warn(
              `[useLazySVG] No SVG returned for node ${nodeId}, falling back to bounding-box`,
            );
            // Fallback to bounding-box rendering
            updateNode(nodeId, (node) => {
              const designNode = node as DesignNode;
              return {
                ...designNode,
                data: {
                  ...designNode.data,
                  renderMode: "bounding-box" as const,
                },
              };
            });
          }

          setIsLoading(false);
        } catch (err) {
          console.error(
            `[useLazySVG] Failed to load SVG for node ${nodeId}:`,
            err,
          );
          setError(err instanceof Error ? err : new Error(String(err)));
          setIsLoading(false);

          // Fallback to bounding-box rendering on error
          updateNode(nodeId, (node) => {
            const designNode = node as DesignNode;
            return {
              ...designNode,
              data: {
                ...designNode.data,
                renderMode: "bounding-box" as const,
              },
            };
          });
        }
      };

      requestSVG();
    }
  }, [nodeId, renderMode, hasSVG, isLoading, updateNode]);

  return { isLoading, error };
}
