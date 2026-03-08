/**
 * SkiaCanvas Component
 *
 * Renders the design using skia-rs-wasm (WASM renderer + worker).
 * Document data comes from the plugin main thread via SET_PENPOT_PAGE and APPLY_PENPOT_CHANGES.
 * Supports pan/zoom and syncs viewport with Figma when provided.
 */

import React, { useEffect, useRef, useCallback } from 'react';
import type { WorkspaceState } from 'skia-rs-wasm';
import {
  CanvasWrapper,
  setDocument,
  applyChanges,
  useWorkspaceStore,
} from 'skia-rs-wasm';
import { syncCanvasWithFigma } from '@/plugin-ui/utils/syncCanvas';
import { uiMessageDispatcher } from '@/plugin-ui/UIMessageDispatcher';
import {
  MessageCategory,
  SystemMessageType,
  ExtractResultType,
  UpdateViewportResponse,
  UpdateViewportRequest,
  SetPenpotPageRequest,
  SetPenpotPageResponse,
  ApplyPenpotChangesRequest,
  ApplyPenpotChangesResponse,
  RequestPenpotPageRequest,
  RequestPenpotPageResponse,
} from '@shared-types/messageTypes';
import type { DesignNode } from '@shared-types/types';
import type { PenpotPage, Change } from 'penpot-exporter/types';

interface SkiaCanvasProps {
  topRightContent?: React.ReactNode;
  bottomRightContent?: React.ReactNode;
  centerRightContent?: React.ReactNode;
  topLeftContent?: React.ReactNode;
  onNodeClick?: (node: DesignNode) => void;
  onNodeHover?: (node: DesignNode | null) => void;
  /** Path to render-wasm.js (e.g. ./wasm/render-wasm.js in plugin build). */
  wasmPath?: string;
  /** Optional worker script URL when worker is built as separate chunk. */
  workerScriptUrl?: string;
}

const rawCdnUrl = (import.meta.env.VITE_CDN_URL as string | undefined)?.replace(/\/+$/, '');
const cdnUrl = (() => {
  if (!rawCdnUrl) return undefined;
  try {
    const u = new URL(rawCdnUrl);
    if (u.hostname === 'localhost') {
      u.hostname = '127.0.0.1';
      return u.toString();
    }
    return rawCdnUrl;
  } catch {
    return rawCdnUrl;
  }
})();

export const SkiaCanvas: React.FC<SkiaCanvasProps> = ({
  topRightContent,
  bottomRightContent,
  centerRightContent,
  topLeftContent,
  onNodeClick: _onNodeClick,
  onNodeHover: _onNodeHover,
  wasmPath: wasmPathProp,
  workerScriptUrl: workerScriptUrlProp,
}) => {
  const wasmPath = wasmPathProp ?? (cdnUrl ? `${cdnUrl}/wasm/render-wasm.js` : './wasm/render-wasm.js');
  const workerScriptUrl = workerScriptUrlProp ?? (cdnUrl ? `${cdnUrl}/worker.js` : undefined);
  const containerRef = useRef<HTMLDivElement>(null);
  const pendingPageRef = useRef<PenpotPage | null>(null);
  const lastViewportRef = useRef<{ panX: number; panY: number; zoom: number } | null>(null);
  const isViewportUpdateInProgressRef = useRef(false);

  const viewport = useWorkspaceStore((s: WorkspaceState) => s.viewport);
  const viewportVersion = useWorkspaceStore((s: WorkspaceState) => s.viewportVersion);
  const documentModel = useWorkspaceStore((s: WorkspaceState) => s.documentModel);

  const applyPendingPage = useCallback(async () => {
    const page = pendingPageRef.current;
    if (!page || !documentModel) return;
    pendingPageRef.current = null;
    const doc = {
      name: '',
      children: [page],
      components: {},
      images: {},
      paintStyles: {},
      textStyles: {},
      componentProperties: {},
      externalLibraries: {},
      missingFonts: [],
      isShared: false,
    };
    await setDocument(doc);
  }, [documentModel]);

  useEffect(() => {
    if (!documentModel) return;
    applyPendingPage();
  }, [documentModel, applyPendingPage]);

  useEffect(() => {
    let cancelled = false;
    uiMessageDispatcher
      .sendRequest<
        Omit<RequestPenpotPageRequest, 'id' | 'timestamp' | 'source'>,
        ExtractResultType<RequestPenpotPageResponse>
      >({
        category: MessageCategory.SYSTEM,
        type: SystemMessageType.REQUEST_PENPOT_PAGE,
        payload: {},
      })
      .then((result) => {
        if (cancelled || !result?.page) return;
        const page = result.page as unknown as PenpotPage;
        if (documentModel) {
          const doc = {
            name: '',
            children: [page],
            components: {},
            images: {},
            paintStyles: {},
            textStyles: {},
            componentProperties: {},
            externalLibraries: {},
            missingFonts: [],
            isShared: false,
          };
          setDocument(doc).catch((err: unknown) => console.warn('[SkiaCanvas] setDocument failed:', err));
        } else {
          pendingPageRef.current = page;
        }
      })
      .catch((err: unknown) => console.warn('[SkiaCanvas] REQUEST_PENPOT_PAGE failed:', err));
    return () => {
      cancelled = true;
    };
  }, [documentModel]);

  useEffect(() => {
    uiMessageDispatcher.registerHandler<
      SetPenpotPageRequest,
      ExtractResultType<SetPenpotPageResponse>
    >(
      MessageCategory.SYSTEM,
      SystemMessageType.SET_PENPOT_PAGE,
      async (request: SetPenpotPageRequest) => {
        const page = request.payload.page as unknown as PenpotPage;
        const model = useWorkspaceStore.getState().documentModel;
        if (model) {
          const doc = {
            name: '',
            children: [page],
            components: {},
            images: {},
            paintStyles: {},
            textStyles: {},
            componentProperties: {},
            externalLibraries: {},
            missingFonts: [],
            isShared: false,
          };
          await setDocument(doc);
        } else {
          pendingPageRef.current = page;
        }
        return { handled: true };
      }
    );

    uiMessageDispatcher.registerHandler<
      ApplyPenpotChangesRequest,
      ExtractResultType<ApplyPenpotChangesResponse>
    >(
      MessageCategory.SYSTEM,
      SystemMessageType.APPLY_PENPOT_CHANGES,
      async (request: ApplyPenpotChangesRequest) => {
        const changes = request.payload.changes as unknown as Change[];
        const pageId = request.payload.pageId;
        const model = useWorkspaceStore((s: WorkspaceState) => s.documentModel);
        if (model && changes.length > 0) {
          await applyChanges(changes, pageId != null ? { pageId } : undefined);
        }
        return { handled: true };
      }
    );
  }, []);

  useEffect(() => {
    if (!viewport || isViewportUpdateInProgressRef.current) return;
    const zoom = viewport.zoom;
    const panX = viewport.panX;
    const panY = viewport.panY;
    const last = lastViewportRef.current;
    lastViewportRef.current = { panX, panY, zoom };
    if (last == null) return;

    const canvasDelta = { x: panX - last.panX, y: panY - last.panY };
    uiMessageDispatcher
      .sendRequest<
        Omit<UpdateViewportRequest, 'id' | 'timestamp' | 'source'>,
        ExtractResultType<UpdateViewportResponse>
      >({
        category: MessageCategory.SYSTEM,
        type: SystemMessageType.UPDATE_VIEWPORT,
        payload: { transform: canvasDelta, zoom, zoomFocalPoint: undefined },
      })
      .catch((err) => console.warn('[SkiaCanvas] Viewport sync failed:', err));
  }, [viewportVersion]);

  useEffect(() => {
    if (!viewport) return;
    let cancelled = false;
    isViewportUpdateInProgressRef.current = true;
    syncCanvasWithFigma()
      .then((vp) => {
        if (cancelled) return;
        const store = useWorkspaceStore.getState();
        if (store.viewport) {
          store.viewport.setPan(-vp.x / vp.zoom, -vp.y / vp.zoom);
          store.viewport.setZoom(vp.zoom);
          store.bumpViewportVersion();
          lastViewportRef.current = { panX: store.viewport.panX, panY: store.viewport.panY, zoom: store.viewport.zoom };
        }
      })
      .finally(() => {
        isViewportUpdateInProgressRef.current = false;
      });
    return () => {
      cancelled = true;
    };
  }, [viewport]);

  return (
    <div ref={containerRef} className="relative h-full w-full">
      <CanvasWrapper
        containerClassName="absolute inset-0"
        wasmPath={wasmPath}
        workerScriptUrl={workerScriptUrl}
      />

      {topRightContent && (
        <div className="absolute top-2 right-2 z-10">{topRightContent}</div>
      )}
      {topLeftContent && (
        <div className="absolute top-2 left-2 z-10 h-[70%] w-[30%]">{topLeftContent}</div>
      )}
      {bottomRightContent && (
        <div className="absolute bottom-2 right-2 z-10">{bottomRightContent}</div>
      )}
      {centerRightContent && (
        <div className="absolute right-2 top-1/2 -translate-y-1/2 z-10">
          {centerRightContent}
        </div>
      )}

      <div className="absolute bottom-4 left-4 z-10 flex flex-col gap-1 rounded-lg border border-gray-200 bg-white shadow-sm">
        <button
          type="button"
          className="p-2 hover:bg-gray-100 rounded-t-lg"
          title="Zoom In"
          onClick={() => {
            const store = useWorkspaceStore.getState();
            if (store.viewport) {
              store.viewport.zoomAt({ x: 0, y: 0 }, 1.5);
              store.bumpViewportVersion();
            }
          }}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
        </button>
        <button
          type="button"
          className="p-2 hover:bg-gray-100 rounded-b-lg"
          title="Zoom Out"
          onClick={() => {
            const store = useWorkspaceStore.getState();
            if (store.viewport) {
              store.viewport.zoomAt({ x: 0, y: 0 }, 1 / 1.5);
              store.bumpViewportVersion();
            }
          }}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
          </svg>
        </button>
      </div>
    </div>
  );
};

export default SkiaCanvas;
