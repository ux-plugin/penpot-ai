import React from 'react';
import { Panel } from '@/plugin-ui/components/Panel.tsx';
import { StatusDetailed } from './StatusDetailed.tsx';

interface StatusPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export const StatusPanel: React.FC<StatusPanelProps> = ({ isOpen, onClose }) => {
  return (
    <Panel isOpen={isOpen} onClose={onClose} title="System Status">
      <StatusDetailed />
    </Panel>
  );
};