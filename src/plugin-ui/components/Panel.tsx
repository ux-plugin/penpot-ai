import React, { useEffect } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/plugin-ui/components/ui/button.tsx';

interface PanelProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  noBackdrop?: boolean;
  side?: 'left' | 'right';
}

export const Panel: React.FC<PanelProps> = ({ 
  isOpen, 
  onClose, 
  title, 
  children, 
  noBackdrop = false,
  side = 'right' 
}) => {
  // Close panel on ESC key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      return () => document.removeEventListener('keydown', handleEscape);
    }
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const sideClasses = side === 'left' 
    ? 'left-0' 
    : 'right-0';
  
  const transformClasses = side === 'left'
    ? (isOpen ? 'translate-x-0' : '-translate-x-full')
    : (isOpen ? 'translate-x-0' : 'translate-x-full');

  return (
    <>
      {/* Backdrop - only render if noBackdrop is false */}
      {!noBackdrop && (
        <div
          className="absolute inset-0 bg-black/20 z-30 transition-opacity"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      {/* Panel */}
      <div
        className={`absolute top-0 ${sideClasses} h-full w-96 bg-white shadow-2xl z-40 transform transition-transform duration-300 ease-in-out ${transformClasses}`}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="text-gray-500 hover:text-gray-700"
          >
            <X className="h-5 w-5" />
          </Button>
        </div>

        {/* Content */}
        <div className="p-4 h-[calc(100%-4rem)] overflow-y-auto">
          {children}
        </div>
      </div>
    </>
  );
};
