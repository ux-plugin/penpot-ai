import React from 'react';
import { CompanionAppStatus } from '@/plugin-ui/components/CompanionAppStatus.tsx';
import { BackendServerStatus } from './BackendServerStatus.tsx';

export const StatusDetailed: React.FC = () => {

  return (
    <div className="space-y-4">
      {/* Both status components */}
      <div className="space-y-3">
        <BackendServerStatus variant="full" />
        <CompanionAppStatus variant="full" />
      </div>
    </div>
  );
};
