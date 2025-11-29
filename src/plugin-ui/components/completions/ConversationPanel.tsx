import React from 'react';
import { Panel } from '@/plugin-ui/components/Panel.tsx';
import { ConversationHistory } from './ConversationHistory.tsx';

interface ConversationPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export const ConversationPanel: React.FC<ConversationPanelProps> = ({ isOpen, onClose }) => {
  return (
    <Panel 
      isOpen={isOpen} 
      onClose={onClose} 
      title="Conversations"
      noBackdrop={true}
      side="left"
    >
      <ConversationHistory />
    </Panel>
  );
};
