import React from 'react';
import { Panel } from '@shared/components/Panel';
import { StatusDetailed } from './StatusDetailed';

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