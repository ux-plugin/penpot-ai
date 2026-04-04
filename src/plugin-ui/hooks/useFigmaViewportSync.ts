import { useRef, useEffect, useCallback } from "react";
import {
  viewport as viewportSignal,
  useSignalCoalesced,
  setViewport,
  zoomAt,
} from "skia-rs-wasm";
import {
  syncCanvasWithFigma,
  type Viewport as FigmaCanvasViewport,
} from "@/plugin-ui/utils/syncCanvas";
import { uiMessageDispatcher } from "@/plugin-ui/UIMessageDispatcher";
import {
  MessageCategory,
  SystemMessageType,
  ExtractResultType,
  UpdateViewportRequest,
  UpdateViewportResponse,
} from "@shared-types/messageTypes";

function workspacePanZoomFromFigma(vp: FigmaCanvasViewport) {
  const panX = -vp.x / vp.zoom;
  const panY = -vp.y / vp.zoom;
  return { panX, panY, zoom: vp.zoom };
}

function applyFigmaViewportToCanvas(vp: FigmaCanvasViewport) {
  const next = workspacePanZoomFromFigma(vp);
  setViewport(next.panX, next.panY, next.zoom);
  return next;
}

/**
 * Handles two-way viewport sync with Figma:
 * - Syncs viewport TO Figma when the canvas viewport changes (pan/zoom).
 * - Syncs FROM Figma on initial viewport availability and when the pointer re-enters the document (after leaving).
 * Exposes zoomIn/zoomOut handlers for UI controls.
 */
export function useFigmaViewportSync(): {
  zoomIn: () => void;
  zoomOut: () => void;
} {
  const viewport = useSignalCoalesced(viewportSignal);

  const lastViewportRef = useRef<{
    panX: number;
    panY: number;
    zoom: number;
  } | null>(null);
  const isViewportUpdateInProgressRef = useRef(false);
  const hasInitialSyncedRef = useRef(false);
  const pointerLeftDocumentRef = useRef(false);
  const syncIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const runSyncFromFigmaRef = useRef<() => void>(() => {});

  // Sync viewport TO Figma when coalesced viewport changes (RAF-batched via useSignalCoalesced).
  useEffect(() => {
    if (!viewport || isViewportUpdateInProgressRef.current) return;
    const zoom = viewport.zoom;
    const panX = viewport.panX;
    const panY = viewport.panY;
    const last = lastViewportRef.current;
    if (last == null) {
      lastViewportRef.current = { panX, panY, zoom };
      return;
    }

    const canvasDelta = { x: panX - last.panX, y: panY - last.panY };
    const EPS = 1e-4;
    const zoomChanged = Math.abs(zoom - last.zoom) > EPS;
    const panChanged =
      Math.abs(canvasDelta.x) > EPS || Math.abs(canvasDelta.y) > EPS;

    if (!zoomChanged && !panChanged) return;

    lastViewportRef.current = { panX, panY, zoom };

    let zoomFocalPoint: { x: number; y: number } | undefined;
    if (zoomChanged) {
      const dz = zoom - last.zoom;
      zoomFocalPoint = {
        x: (panX * zoom - last.panX * last.zoom) / dz,
        y: (panY * zoom - last.panY * last.zoom) / dz,
      };
    }

    uiMessageDispatcher
      .sendRequest<
        Omit<UpdateViewportRequest, "id" | "timestamp" | "source">,
        ExtractResultType<UpdateViewportResponse>
      >({
        category: MessageCategory.SYSTEM,
        type: SystemMessageType.UPDATE_VIEWPORT,
        payload: {
          transform: zoomChanged ? { x: 0, y: 0 } : canvasDelta,
          zoom,
          zoomFocalPoint,
        },
      })
      .catch((err) =>
        console.warn("[useFigmaViewportSync] Viewport sync failed:", err),
      );
  }, [viewport]);

  // Initial sync FROM Figma once when viewport first becomes available.
  useEffect(() => {
    if (!viewport) {
      hasInitialSyncedRef.current = false;
      return;
    }
    if (hasInitialSyncedRef.current) return;
    hasInitialSyncedRef.current = true;
    let cancelled = false;
    isViewportUpdateInProgressRef.current = true;
    syncCanvasWithFigma()
      .then((vp) => {
        if (cancelled) return;
        lastViewportRef.current = applyFigmaViewportToCanvas(vp);
      })
      .finally(() => {
        // Delay clearing the guard until after the next RAF so the coalesced
        // viewport signal (which also fires on RAF) is suppressed and doesn't
        // bounce the update back to Figma.
        requestAnimationFrame(() => {
          isViewportUpdateInProgressRef.current = false;
        });
      });
    return () => {
      cancelled = true;
    };
  }, [viewport]);

  const runSyncFromFigma = useCallback(() => {
    if (!viewport) return;
    isViewportUpdateInProgressRef.current = true;
    syncCanvasWithFigma()
      .then((vp) => {
        lastViewportRef.current = applyFigmaViewportToCanvas(vp);
      })
      .catch((err) =>
        console.warn("[useFigmaViewportSync] Sync from Figma failed:", err),
      )
      .finally(() => {
        // Delay clearing the guard until after the next RAF so the coalesced
        // viewport signal (which also fires on RAF) is suppressed and doesn't
        // bounce the update back to Figma.
        requestAnimationFrame(() => {
          isViewportUpdateInProgressRef.current = false;
        });
      });
  }, [viewport]);

  runSyncFromFigmaRef.current = runSyncFromFigma;

  useEffect(() => {
    const onPointerLeave = (e: PointerEvent) => {
      if (
        !e.relatedTarget ||
        !(e.relatedTarget instanceof Node) ||
        !document.contains(e.relatedTarget)
      ) {
        pointerLeftDocumentRef.current = true;
        if (!syncIntervalRef.current) {
          syncIntervalRef.current = setInterval(
            () => runSyncFromFigmaRef.current(),
            500,
          );
        }
      }
    };
    const onPointerMove = () => {
      if (pointerLeftDocumentRef.current) {
        pointerLeftDocumentRef.current = false;
        if (syncIntervalRef.current) {
          clearInterval(syncIntervalRef.current);
          syncIntervalRef.current = null;
        }
        runSyncFromFigmaRef.current();
      }
    };
    document.addEventListener("pointerleave", onPointerLeave, true);
    document.addEventListener("pointermove", onPointerMove, true);
    return () => {
      document.removeEventListener("pointerleave", onPointerLeave, true);
      document.removeEventListener("pointermove", onPointerMove, true);
      if (syncIntervalRef.current) {
        clearInterval(syncIntervalRef.current);
        syncIntervalRef.current = null;
      }
    };
  }, []);

  const zoomIn = useCallback(() => {
    zoomAt({ x: 0, y: 0 }, 1.5);
  }, []);

  const zoomOut = useCallback(() => {
    zoomAt({ x: 0, y: 0 }, 1 / 1.5);
  }, []);

  return { zoomIn, zoomOut };
}
