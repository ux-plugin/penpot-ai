import React from 'react';
import { HelpCircle } from 'lucide-react';
import { Button } from '@ui/button';

interface HelpButtonProps {
  onClick?: () => void;
}

export const HelpButton: React.FC<HelpButtonProps> = ({ onClick }) => {
  return (
    <Button
      variant="default"
      size="icon"
      className="fixed bottom-6 right-6 z-50 h-12 w-12 rounded-full bg-gray-900 text-white shadow-lg hover:bg-gray-800"
      onClick={onClick}
      title="Help"
    >
      <HelpCircle className="h-6 w-6" />
    </Button>
  );
};