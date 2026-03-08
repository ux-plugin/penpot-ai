import { useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import { uiMessageDispatcher } from '@/plugin-ui/UIMessageDispatcher.ts';
import { MessageCategory, SystemMessageType, ResizeRequest, ExtractResultType, ResizeResponse } from '@shared-types/messageTypes.ts';

let _lastMoveLog = 0;

interface WindowResizeHandleProps {
  minWidth?: number;
  minHeight?: number;
  className?: string;
  children?: ReactNode;
}

export function WindowResizeHandle({
  minWidth = 300,
  minHeight = 200,
  children
}: WindowResizeHandleProps) {
  const [isResizing, setIsResizing] = useState(false);
  const handleRef = useRef<HTMLDivElement>(null);
  const pointerIdRef = useRef<number | null>(null);

  const handleResizeStart = (e: React.PointerEvent) => {
    e.preventDefault();
    pointerIdRef.current = e.pointerId;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    // #region agent log
    fetch('http://127.0.0.1:7245/ingest/f0136137-81f1-4f6e-a7b5-217ac99b12a5',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'WindowResizeHandle.tsx:handleResizeStart',message:'resize_start',data:{},timestamp:Date.now(),hypothesisId:'H-D'})}).catch(()=>{});
    // #endregion
    setIsResizing(true);
  };

  const handleResizeMove = async (e: PointerEvent) => {
    if (!isResizing) return;
    // #region agent log
    const now = Date.now(); if (now - _lastMoveLog > 150) { _lastMoveLog = now; fetch('http://127.0.0.1:7245/ingest/f0136137-81f1-4f6e-a7b5-217ac99b12a5',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'WindowResizeHandle.tsx:handleResizeMove',message:'resize_move',data:{clientX:e.clientX,clientY:e.clientY},timestamp:now,hypothesisId:'H-D'})}).catch(()=>{}); }
    // #endregion
    // Content area size from cursor; add scrollbar size so requested size gives the desired content area
    const scrollbarW = window.innerWidth - document.documentElement.clientWidth;
    const scrollbarH = window.innerHeight - document.documentElement.clientHeight;
    const newWidth = e.clientX + scrollbarW;
    const newHeight = e.clientY + scrollbarH;

    // Enforce minimum size (avoids tiny window and scrollbars)
    const width = Math.max(newWidth, minWidth);
    const height = Math.max(newHeight, minHeight);
    // Plugin API (e.g. Figma) requires integer dimensions
    const widthInt = Math.round(width);
    const heightInt = Math.round(height);

    try {
      await uiMessageDispatcher.sendRequest<
        Omit<ResizeRequest, 'id' | 'timestamp' | 'source'>,
        ExtractResultType<ResizeResponse>
      >({
        category: MessageCategory.SYSTEM,
        type: SystemMessageType.RESIZE,
        payload: {
          width: widthInt,
          height: heightInt
        }
      });
    } catch (error) {
      console.error('Failed to resize window:', error);
    }
  };

  const handleResizeEnd = useCallback(() => {
    if (handleRef.current != null && pointerIdRef.current != null) {
      try { handleRef.current.releasePointerCapture(pointerIdRef.current); } catch (_) {}
      pointerIdRef.current = null;
    }
    setIsResizing(false);
  }, []);

  const endWithSource = useCallback((source: string) => {
    // #region agent log
    fetch('http://127.0.0.1:7245/ingest/f0136137-81f1-4f6e-a7b5-217ac99b12a5',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'WindowResizeHandle.tsx:endWithSource',message:'resize_end',data:{source},timestamp:Date.now(),hypothesisId:'H-A'})}).catch(()=>{});
    // #endregion
    handleResizeEnd();
  }, [handleResizeEnd]);

  // Global listeners: pointer capture keeps events on this doc when pointer leaves, so we don't end on mouseleave
  useEffect(() => {
    if (isResizing) {
      const onPointerUp = () => endWithSource('pointerup');
      const onPointerCancel = () => endWithSource('pointercancel');
      const onBlur = () => endWithSource('blur');
      window.addEventListener('pointermove', handleResizeMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerCancel);
      window.addEventListener('blur', onBlur);
      // Do NOT listen to mouseleave - it fires when cursor leaves the (shrinking) window and aborted resize (log evidence)

      return () => {
        // #region agent log
        fetch('http://127.0.0.1:7245/ingest/f0136137-81f1-4f6e-a7b5-217ac99b12a5',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'WindowResizeHandle.tsx:effect_cleanup',message:'resize_effect_cleanup',data:{},timestamp:Date.now(),hypothesisId:'H-C'})}).catch(()=>{});
        // #endregion
        window.removeEventListener('pointermove', handleResizeMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerCancel);
        window.removeEventListener('blur', onBlur);
      };
    }
  }, [isResizing, handleResizeEnd, endWithSource]);

  return (
    <div
      ref={handleRef}
      className="h-5 w-5 fixed z-50 flex items-center space-x-2 text-gray-500 hover:text-gray-700 transition-colors duration-300 bottom-0 right-0 cursor-nwse-resize"
      onPointerDown={handleResizeStart}
      title="Drag to resize window"
    >
      {children}
    </div>
  );
}
