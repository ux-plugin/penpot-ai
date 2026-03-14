import { useRef, useEffect, useCallback } from "react";
import { useWorkspaceStore, setPan, setZoom, zoomAt } from "skia-rs-wasm";
import { syncCanvasWithFigma } from "@/plugin-ui/utils/syncCanvas";
import { uiMessageDispatcher } from "@/plugin-ui/UIMessageDispatcher";
import {
  MessageCategory,
  SystemMessageType,
  ExtractResultType,
  UpdateViewportRequest,
  UpdateViewportResponse,
} from "@shared-types/messageTypes";

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
  const viewport = useWorkspaceStore((s) => s.viewport);
  const isPanning = useWorkspaceStore((s) => s.isPanning);

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

  // Effect A: Sync viewport TO Figma when viewport reference changes.
  // During active pan we skip syncing and only sync when pan ends (for performance).
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
    const zoomChanged = zoom !== last.zoom;
    if (!zoomChanged && isPanning) return;

    // Only update last when we actually send, so pan-end sync gets correct delta from last sent position
    lastViewportRef.current = { panX, panY, zoom };

    // When zoom changes, back-compute the world focal point that was held fixed during
    // the zoom gesture. Sending it lets Figma apply the correct zoom-at-point formula
    // instead of incorrectly treating the top-left delta as a center delta.
    // Derivation: panX_old + focalX/oldZoom = panX_new + focalX/newZoom
    //   => focalX = (panX_new * newZoom - panX_old * oldZoom) / (newZoom - oldZoom)
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
  }, [viewport, isPanning]);

  // Effect B: Initial sync FROM Figma only once when viewport first becomes available.
  // Do not run on every viewport change (that caused a loop: viewport change → sync from Figma → setPan/setZoom → viewport change → repeat).
  // Sync from Figma also runs on pointer re-enter and every 500ms when pointer is outside the canvas.
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
        const panX = -vp.x / vp.zoom;
        const panY = -vp.y / vp.zoom;
        setPan(panX, panY);
        setZoom(vp.zoom);
        lastViewportRef.current = { panX, panY, zoom: vp.zoom };
      })
      .finally(() => {
        isViewportUpdateInProgressRef.current = false;
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
        const panX = -vp.x / vp.zoom;
        const panY = -vp.y / vp.zoom;
        setPan(panX, panY);
        setZoom(vp.zoom);
        lastViewportRef.current = { panX, panY, zoom: vp.zoom };
      })
      .catch((err) =>
        console.warn("[useFigmaViewportSync] Sync from Figma failed:", err),
      )
      .finally(() => {
        isViewportUpdateInProgressRef.current = false;
      });
  }, [viewport]);

  // Keep ref updated so interval always calls latest sync (without re-running effect and clearing interval)
  runSyncFromFigmaRef.current = runSyncFromFigma;

  // Pointer leave/reenter: sync from Figma on re-enter and on interval while pointer is out.
  // Use ref for runSyncFromFigma so this effect does not depend on viewport; otherwise viewport
  // changes (e.g. after initial sync) would re-run the effect, clear the interval, and timer sync would stop.
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
