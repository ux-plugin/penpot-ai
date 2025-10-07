import React from 'react';
import { usePortUpdatesStore } from '@user/stores/usePortUpdatesStore';
import { useCompanionStatus, useCompanionConnection } from '../api/companionAppHooks.ts';
import { Badge } from '@ui/badge';
import { Button } from '@ui/button';
import { LaptopWithWifiIcon } from '@assets/icons/LaptopWithWifiIcon';

interface CompanionAppStatusProps {
  variant?: 'icon' | 'full' | 'badge';
  className?: string;
}

export const CompanionAppStatus: React.FC<CompanionAppStatusProps> = ({ 
  variant = 'icon',
  className = ''
}) => {
  // Use custom hooks for better connection management
  const companionStatus = useCompanionStatus();
  const companionConnection = useCompanionConnection();
  
  // Get port info from port updates store
  const { currentPort } = usePortUpdatesStore();

  const getWifiState = () => {
    if (companionStatus.isConnecting) return 'connecting';
    if (companionStatus.isConnected) return 'connected';
    return 'disconnected';
  };

  const getStatusColors = () => {
    if (companionStatus.isConnecting) return { main: 'text-yellow-600', wifi: 'text-yellow-600' };
    if (companionStatus.isConnected) return { main: 'text-green-600', wifi: 'text-green-600' };
    if (companionStatus.error) return { main: 'text-red-600', wifi: 'text-red-600' };
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
    if (companionStatus.isConnecting) return 'Handshake in progress...';
    if (companionStatus.isConnected) return `Companion connected${currentPort ? ` (Port ${currentPort})` : ''}`;
    if (companionStatus.error) return `Companion error: ${companionStatus.error}`;
    return 'Companion disconnected';
  };

  const getStatusVariant = () => {
    if (companionStatus.isConnecting) return 'secondary';
    if (companionStatus.isConnected) return 'default';
    return 'outline';
  };

  const handleConnect = async () => {
    try {
      await companionConnection.connect();
    } catch (error) {
      console.error('Failed to connect to companion app:', error);
    }
  };

  const handleDisconnect = () => {
    companionConnection.disconnect();
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
        
        {companionStatus.isConnected ? (
          <Button
            size="sm"
            variant="outline"
            onClick={handleDisconnect}
            disabled={companionStatus.isConnecting}
          >
            Disconnect
          </Button>
        ) : (
          <Button
            size="sm"
            variant="default"
            onClick={handleConnect}
            disabled={companionStatus.isConnecting || !companionStatus.hasPort}
          >
            {companionStatus.isConnecting ? 'Connecting...' : 'Connect'}
          </Button>
        )}
      </div>
    </div>
  );
};
