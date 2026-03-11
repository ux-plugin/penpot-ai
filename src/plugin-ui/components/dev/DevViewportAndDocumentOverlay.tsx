/**
 * Dev-only overlay showing viewport coordinates, zoom, and documentModel content.
 * Renders only when VITE_ENABLE_BUILD_DEBUG === "true".
 */

import { useState, useMemo } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useWorkspaceStore } from 'skia-rs-wasm';
import type { WorkspaceState } from 'skia-rs-wasm';

/** Minimal shape for display (documentModel.getPage returns IndexedPage). */
interface PageSummary {
  id: string;
  name?: string;
  objects: Record<string, { id?: string; type?: string; name?: string }>;
}

function safeGetPageSummary(
  documentModel: WorkspaceState['documentModel'],
  pageId: string | null
): PageSummary | null {
  if (!documentModel || !pageId) return null;
  const page = documentModel.getPage(pageId);
  if (!page || !('objects' in page)) return null;
  const objects = page.objects as Record<string, { id?: string; type?: string; name?: string }>;
  return {
    id: page.id,
    name: page.name,
    objects,
  };
}

/** Safe JSON stringify with depth limit to avoid circular refs and huge output. */
function safeJsonSummary(obj: unknown, maxDepth: number): string {
  function stringify(o: unknown, depth: number): string {
    if (depth <= 0) return '…';
    if (o === null) return 'null';
    if (typeof o !== 'object') return JSON.stringify(o);
    if (Array.isArray(o)) {
      const items = o.slice(0, 5).map((item) => stringify(item, depth - 1));
      const tail = o.length > 5 ? `,…(${o.length - 5} more)` : '';
      return '[' + items.join(',') + tail + ']';
    }
    const keys = Object.keys(o as object).filter(
      (k) => !['children', 'shapes'].includes(k) || depth > 1
    );
    const pairs = keys.slice(0, 15).map((k) => `${JSON.stringify(k)}:${stringify((o as Record<string, unknown>)[k], depth - 1)}`);
    const tail = keys.length > 15 ? `,…(${keys.length - 15} more keys)` : '';
    return '{' + pairs.join(',') + tail + '}';
  }
  return stringify(obj, maxDepth);
}

export function DevViewportAndDocumentOverlay() {
  const viewport = useWorkspaceStore((s: WorkspaceState) => s.viewport);
  const pageId = useWorkspaceStore((s: WorkspaceState) => s.pageId);
  const documentModel = useWorkspaceStore((s: WorkspaceState) => s.documentModel);

  const [expandedDoc, setExpandedDoc] = useState(false);
  const [expandJson, setExpandJson] = useState(false);

  const pageSummary = useMemo(
    () => safeGetPageSummary(documentModel, pageId),
    [documentModel, pageId]
  );

  if (import.meta.env.VITE_ENABLE_BUILD_DEBUG !== 'true') {
    return null;
  }

  const zoom = viewport?.zoom ?? 1;
  const panX = viewport?.panX ?? 0;
  const panY = viewport?.panY ?? 0;

  return (
    <div
      className="fixed bottom-4 right-4 z-40 flex flex-col gap-1 rounded-lg border border-gray-700 bg-gray-900/95 px-3 py-2 font-mono text-xs text-white shadow-lg backdrop-blur-sm"
      style={{ maxWidth: '320px' }}
    >
      <div className="flex items-center gap-2 text-gray-300">
        <span>Zoom: {(zoom * 100).toFixed(1)}%</span>
        <span>|</span>
        <span title="World-space visible top-left">
          Pan: ({panX.toFixed(1)}, {panY.toFixed(1)})
        </span>
      </div>
      <div className="border-t border-gray-700 pt-1.5">
        {!documentModel || !pageId ? (
          <span className="text-gray-500">Document not loaded</span>
        ) : !pageSummary ? (
          <span className="text-gray-500">Page not found</span>
        ) : (
          <>
            <button
              type="button"
              className="flex w-full items-center gap-1 text-left text-gray-300 hover:text-white"
              onClick={() => setExpandedDoc((e) => !e)}
              aria-expanded={expandedDoc}
            >
              {expandedDoc ? (
                <ChevronDown className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 shrink-0" />
              )}
              <span>
                Page: {pageSummary.name ?? pageSummary.id} ({Object.keys(pageSummary.objects).length} objects)
              </span>
            </button>
            {expandedDoc && (
              <div className="mt-1.5 pl-4 text-gray-400">
                <div className="mb-1">
                  <span className="text-gray-500">id:</span> {pageSummary.id}
                </div>
                <div className="max-h-32 overflow-y-auto">
                  <button
                    type="button"
                    className="mb-1 text-gray-500 hover:text-gray-400"
                    onClick={() => setExpandJson((e) => !e)}
                  >
                    {expandJson ? 'Hide JSON' : 'Show page JSON (depth 2)'}
                  </button>
                  {expandJson && (
                    <pre className="whitespace-pre-wrap break-all text-[10px]">
                      {safeJsonSummary(
                        {
                          id: pageSummary.id,
                          name: pageSummary.name,
                          objectCount: Object.keys(pageSummary.objects).length,
                          objectIds: Object.keys(pageSummary.objects).slice(0, 50),
                        },
                        2
                      )}
                    </pre>
                  )}
                  {!expandJson && (
                    <ul className="list-inside list-disc space-y-0.5">
                      {Object.entries(pageSummary.objects)
                        .slice(0, 20)
                        .map(([id, shape]) => (
                          <li key={id}>
                            {id}
                            {(shape as { type?: string }).type != null &&
                              ` (${(shape as { type: string }).type})`}
                          </li>
                        ))}
                      {Object.keys(pageSummary.objects).length > 20 && (
                        <li className="text-gray-500">
                          … +{Object.keys(pageSummary.objects).length - 20} more
                        </li>
                      )}
                    </ul>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
