import React, { useState } from 'react';
import { usePortUpdatesStore } from '@/plugin-ui/stores/usePortUpdatesStore.ts';
import { useCompanionConnection } from "@/plugin-ui/api/companion";
import { useCompanionStore, selectIsCompanionConnecting, selectIsConnected } from '@/plugin-ui/stores/useCompanionStore.ts';
import { Badge } from '@ui/badge';
import { Button } from '@ui/button';
import { LaptopWithWifiIcon } from '@assets/icons/LaptopWithWifiIcon.tsx';

interface CompanionAppStatusProps {
  variant?: 'icon' | 'full' | 'badge';
  className?: string;
}

export const CompanionAppStatus: React.FC<CompanionAppStatusProps> = ({ 
  variant = 'icon',
  className = ''
}) => {
  // Get state from store
  const isConnecting = useCompanionStore(selectIsCompanionConnecting);
  const isConnected = useCompanionStore(selectIsConnected);
  
  // Get connection actions
  const { connect, disconnect } = useCompanionConnection();
  
  // Local error state
  const [connectionError, setConnectionError] = useState<string | null>(null);
  
  // Get port info from port updates store
  const { currentPort } = usePortUpdatesStore();

  const getWifiState = () => {
    if (isConnecting) return 'connecting';
    if (isConnected) return 'connected';
    return 'disconnected';
  };

  const getStatusColors = () => {
    if (isConnecting) return { main: 'text-yellow-600', wifi: 'text-yellow-600' };
    if (isConnected) return { main: 'text-green-600', wifi: 'text-green-600' };
    if (connectionError) return { main: 'text-red-600', wifi: 'text-red-600' };
    return { main: 'text-gray-500', wifi: 'text-gray-500' };
  };

  const getStatusIcon = () => {
    const colors = getStatusColors();
    return (
      <LaptopWithWifiIcon 
        wifiState={getWifiState()} 
        className={colors.main} 
        size={variant === 'icon' ? 20 : 24} 
      />
    );
  };

  const getStatusText = () => {
    if (isConnecting) return 'Handshake in progress...';
    if (isConnected) return `Companion connected${currentPort ? ` (Port ${currentPort})` : ''}`;
    if (connectionError) return `Companion error: ${connectionError}`;
    return 'Companion disconnected';
  };

  const getStatusVariant = () => {
    if (isConnecting) return 'secondary';
    if (isConnected) return 'default';
    return 'outline';
  };

  const handleConnect = async () => {
    try {
      setConnectionError(null);
      await connect();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to connect to companion app';
      console.error('Failed to connect to companion app:', errorMessage);
      setConnectionError(errorMessage);
    }
  };

  const handleDisconnect = () => {
    setConnectionError(null);
    disconnect();
  };

  if (variant === 'icon') {
    return (
      <div 
        className={`flex items-center justify-center p-2 rounded-full ${className}`}
        title={getStatusText()}
      >
        {getStatusIcon()}
      </div>
    );
  }

  if (variant === 'badge') {
    return (
      <Badge 
        variant={getStatusVariant() as any}
        className={className}
      >
        <div className="flex items-center space-x-1">
          {getStatusIcon()}
          <span className="text-xs">Companion</span>
        </div>
      </Badge>
    );
  }

  // Full variant with connect/disconnect functionality
  return (
    <div className={`flex items-center justify-between p-3 border rounded-lg ${className}`}>
      <div className="flex items-center space-x-3">
        {getStatusIcon()}
        <div>
          <p className="text-sm font-medium">Companion App</p>
          <p className="text-xs text-gray-500">{getStatusText()}</p>
        </div>
      </div>
      
      <div className="flex items-center space-x-2">
        <div className="text-xs text-gray-500">
          {currentPort ? `Port ${currentPort}` : 'No port configured'}
        </div>
        
        {isConnected ? (
          <Button
            size="sm"
            variant="outline"
            onClick={handleDisconnect}
            disabled={isConnecting}
          >
            Disconnect
          </Button>
        ) : (
          <Button
            size="sm"
            variant="default"
            onClick={handleConnect}
            disabled={isConnecting || !currentPort}
          >
            {isConnecting ? 'Connecting...' : 'Connect'}
          </Button>
        )}
      </div>
    </div>
  );
};
