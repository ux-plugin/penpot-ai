import { useState, useEffect, ReactNode } from 'react';
import { uiMessageDispatcher } from '@messaging/UIMessageDispatcher';
import { MessageCategory, SystemMessageType, ResizeRequest, ExtractResultType, ResizeResponse } from '@shared-core/types/messageTypes';

interface WindowResizeHandleProps {
  minWidth?: number;
  minHeight?: number;
  className?: string;
  children?: ReactNode;
}

export function WindowResizeHandle({
  minWidth = 70,
  minHeight = 50,
  children
}: WindowResizeHandleProps) {
  const [isResizing, setIsResizing] = useState(false);

  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  };

  const handleResizeMove = async (e: MouseEvent) => {
    if (!isResizing) return;

    // Bottom-right: Only dimensions change, position stays the same
    const newWidth = e.clientX;
    const newHeight = e.clientY;

    // Enforce minimum size
    const width = Math.max(newWidth, minWidth);
    const height = Math.max(newHeight, minHeight);

    try {
      await uiMessageDispatcher.sendRequest<
        Omit<ResizeRequest, 'id' | 'timestamp' | 'source'>,
        ExtractResultType<ResizeResponse>
      >({
        category: MessageCategory.SYSTEM,
        type: SystemMessageType.RESIZE,
        payload: {
          width,
          height
        }
      });
    } catch (error) {
      console.error('Failed to resize window:', error);
    }
  };

  const handleResizeEnd = () => {
    setIsResizing(false);
  };

  // Add global event listeners for resize dragging
  useEffect(() => {
    if (isResizing) {
      window.addEventListener('mousemove', handleResizeMove);
      window.addEventListener('mouseup', handleResizeEnd);

      return () => {
        window.removeEventListener('mousemove', handleResizeMove);
        window.removeEventListener('mouseup', handleResizeEnd);
      };
    }
  }, [isResizing]);

  return (
    <div
      className="h-5 w-5 fixed z-50 flex items-center space-x-2 text-gray-500 hover:text-gray-700 transition-colors duration-300 bottom-0 right-0 cursor-nwse-resize"
      onMouseDown={handleResizeStart}
      title="Drag to resize window"
    >
      {children}
    </div>
  );
}
