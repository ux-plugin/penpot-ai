/**
 * SkiaCanvas Component
 *
 * Renders the design using skia-rs-wasm (WASM renderer + worker).
 * Document data comes from the plugin main thread via SET_PENPOT_PAGE, ADD_PENPOT_PAGE, and APPLY_PENPOT_CHANGES (skia-rs-wasm page-crud).
 * Supports pan/zoom and syncs viewport with Figma when provided.
 */

import React, { useEffect, useRef, useCallback, useState } from 'react';
import type { WorkspaceState } from 'skia-rs-wasm';
import {
  CanvasWrapper,
  setDocument,
  addPage,
  applyChanges,
  useWorkspaceStore,
} from 'skia-rs-wasm';
import { useFigmaViewportSync } from '@/plugin-ui/hooks/useFigmaViewportSync';
import { uiMessageDispatcher } from '@/plugin-ui/UIMessageDispatcher';
import {
  MessageCategory,
  SystemMessageType,
  ExtractResultType,
  AddPenpotPageRequest,
  AddPenpotPageResponse,
  ApplyPenpotChangesRequest,
  ApplyPenpotChangesResponse,
  RequestPenpotPageRequest,
  RequestPenpotPageResponse,
} from '@shared-types/messageTypes';
import type { DesignNode } from '@shared-types/types';
import type { PenpotPage, Change } from 'penpot-exporter/types';

/** Debug: summarize Penpot page tree for text fills + frame/page background (hypotheses H1–H3, H5). */
function collectPenpotPageDebug(page: Record<string, unknown>): {
  background: unknown;
  firstFrame: { fillsLen: number; fillStyleId?: unknown } | null;
  textSamples: Array<{
    charactersLen: number;
    contentHasChildren: boolean;
    span0FillsLen: number;
    span0HasFillStyleId: boolean;
  }>;
} {
  const textSamples: Array<{
    charactersLen: number;
    contentHasChildren: boolean;
    span0FillsLen: number;
    span0HasFillStyleId: boolean;
  }> = [];
  let firstFrame: { fillsLen: number; fillStyleId?: unknown } | null = null;

  const visit = (node: Record<string, unknown>) => {
    const t = node.type;
    if (t === 'frame' && !firstFrame) {
      const fills = node.fills;
      firstFrame = {
        fillsLen: Array.isArray(fills) ? fills.length : -1,
        fillStyleId: node.fillStyleId,
      };
    }
    if (t === 'text') {
      const content = node.content as Record<string, unknown> | undefined;
      const rootKids = content?.children as unknown[] | undefined;
      const paragraphSet = rootKids?.[0] as Record<string, unknown> | undefined;
      const psetKids = paragraphSet?.children as unknown[] | undefined;
      const paragraph = psetKids?.[0] as Record<string, unknown> | undefined;
      const spans = paragraph?.children as unknown[] | undefined;
      const span0 = spans?.[0] as Record<string, unknown> | undefined;
      const ch = (node as { characters?: string }).characters;
      textSamples.push({
        charactersLen: typeof ch === 'string' ? ch.length : 0,
        contentHasChildren: Array.isArray(rootKids) && rootKids.length > 0,
        span0FillsLen: Array.isArray(span0?.fills) ? (span0.fills as unknown[]).length : -1,
        span0HasFillStyleId: !!(
          span0 &&
          span0.fillStyleId &&
          String(span0.fillStyleId).length > 0
        ),
      });
    }
    const kids = node.children as unknown[] | undefined;
    if (Array.isArray(kids)) {
      for (const c of kids) {
        if (c && typeof c === 'object') visit(c as Record<string, unknown>);
      }
    }
  };

  const top = page.children as unknown[] | undefined;
  if (Array.isArray(top)) {
    for (const c of top) {
      if (c && typeof c === 'object') visit(c as Record<string, unknown>);
    }
  }

  return {
    background: page.background,
    firstFrame,
    textSamples: textSamples.slice(0, 12),
  };
}

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
  const { zoomIn, zoomOut } = useFigmaViewportSync();

  const documentModel = useWorkspaceStore((s: WorkspaceState) => s.documentModel);
  const renderer = useWorkspaceStore((s: WorkspaceState) => s.renderer);
  const workerClient = useWorkspaceStore((s: WorkspaceState) => s.workerClient);
  const wasmModule = useWorkspaceStore((s: WorkspaceState) => s.wasmModule);

  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoadingDocument, setIsLoadingDocument] = useState(false);

  const buildDocFromPage = useCallback((page: PenpotPage) => ({
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
  }), []);

  const handleLoadDocument = useCallback(() => {
    if (!renderer || !workerClient || !wasmModule) return;
    setLoadError(null);
    setIsLoadingDocument(true);
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
        if (!result?.page) {
          setLoadError('No page received');
          return;
        }
        const page = result.page as unknown as PenpotPage;
        // #region agent log
        {
          const dbg = collectPenpotPageDebug(page as unknown as Record<string, unknown>);
          fetch('http://127.0.0.1:7245/ingest/c70ec86b-9ad9-405f-b916-1c6ac9ad8098', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Debug-Session-Id': '05c835',
            },
            body: JSON.stringify({
              sessionId: '05c835',
              runId: 'pre-fix',
              hypothesisId: 'H1-H5',
              location: 'SkiaCanvas.tsx:REQUEST_PENPOT_PAGE',
              message: 'Penpot page payload after Figma translatePage',
              data: {
                ...dbg,
                textNodeCount: dbg.textSamples.length,
              },
              timestamp: Date.now(),
            }),
          }).catch(() => {});
        }
        // #endregion
        setDocument(buildDocFromPage(page))
          .then(() => setLoadError(null))
          .catch((err: unknown) => {
            console.warn('[SkiaCanvas] setDocument failed:', err);
            setLoadError(err instanceof Error ? err.message : 'Failed to load document');
          });
      })
      .catch((err: unknown) => {
        console.warn('[SkiaCanvas] REQUEST_PENPOT_PAGE failed:', err);
        setLoadError(err instanceof Error ? err.message : 'Request failed');
      })
      .finally(() => setIsLoadingDocument(false));
  }, [renderer, workerClient, wasmModule, buildDocFromPage]);

  useEffect(() => {

    uiMessageDispatcher.registerHandler<
      AddPenpotPageRequest,
      ExtractResultType<AddPenpotPageResponse>
    >(
      MessageCategory.SYSTEM,
      SystemMessageType.ADD_PENPOT_PAGE,
      async (request: AddPenpotPageRequest) => {
        const page = request.payload.page as unknown as PenpotPage;
        await addPage(page);
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
        // Must use getState() — hooks cannot run inside async message handlers (React #321).
        const model = useWorkspaceStore.getState().documentModel;
        const storePageId = useWorkspaceStore.getState().pageId;
        if (model && changes.length > 0) {
          await applyChanges(
            changes,
            storePageId != null ? { pageId: storePageId } : undefined,
          );
        }
        return { handled: true };
      }
    );
  }, []);

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

      {!documentModel && (
        <div className="absolute top-4 left-4 z-10 flex flex-col gap-2 rounded-lg border border-gray-200 bg-white p-2 shadow-sm">
          <button
            type="button"
            className="rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            title="Load the current Penpot page into the canvas"
            disabled={!renderer || !workerClient || !wasmModule || isLoadingDocument}
            onClick={handleLoadDocument}
          >
            {isLoadingDocument ? 'Loading…' : 'Load document'}
          </button>
          {loadError && (
            <p className="max-w-[200px] text-xs text-red-600">{loadError}</p>
          )}
        </div>
      )}

      <div className="absolute bottom-4 left-4 z-10 flex flex-col gap-1 rounded-lg border border-gray-200 bg-white shadow-sm">
        <button
          type="button"
          className="p-2 hover:bg-gray-100 rounded-t-lg"
          title="Zoom In"
          onClick={zoomIn}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
        </button>
        <button
          type="button"
          className="p-2 hover:bg-gray-100 rounded-b-lg"
          title="Zoom Out"
          onClick={zoomOut}
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
