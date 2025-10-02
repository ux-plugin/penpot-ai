import React from 'react';
import { RefreshCw } from 'lucide-react';
import { usePortUpdatesStore } from '@user/stores/usePortUpdatesStore';
import { Button } from '@ui/button';
import { Badge } from '@ui/badge';
import { ServerWithWifiIcon } from '@assets/icons/ServerWithWifiIcon';

interface BackendServerStatusProps {
  variant?: 'icon' | 'full' | 'badge';
  className?: string;
}

export const BackendServerStatus: React.FC<BackendServerStatusProps> = ({ 
  variant = 'icon',
  className = ''
}) => {
  const {
    isConnected,
    isConnecting,
    error,
    connect,
    disconnect
  } = usePortUpdatesStore();


  const getWifiState = () => {
    if (isConnecting) return 'connecting';
    if (isConnected) return 'connected';
    return 'disconnected';
  };

  const getStatusColors = () => {
    if (isConnecting) return { main: 'text-yellow-600', wifi: 'text-yellow-600' };
    if (isConnected) return { main: 'text-green-600', wifi: 'text-green-600' };
    if (error) return { main: 'text-red-600', wifi: 'text-red-600' };
    return { main: 'text-gray-500', wifi: 'text-gray-500' };
  };

  const getStatusIcon = () => {
    const colors = getStatusColors();
    return (
      <ServerWithWifiIcon 
        wifiState={getWifiState()} 
        className={colors.main} 
        size={variant === 'icon' ? 20 : 24} 
      />
    );
  };

  const getStatusText = () => {
    if (isConnecting) return 'Connecting to backend server...';
    if (isConnected) return 'Backend server connected';
    if (error) return `Server error: ${error}`;
    return 'Backend server disconnected';
  };

  const getStatusVariant = () => {
    if (isConnecting) return 'secondary';
    if (isConnected) return 'default';
    return 'outline';
  };

  const handleConnect = async () => {
    console.log('Connecting to backend server...');
    try {
      await connect();
    } catch (error) {
      console.log('Failed to connect to backend server:', error);
    }
    console.log('finished connecting')
  };

  const handleDisconnect = () => {
    console.log('Disconnecting from backend server...');
    disconnect();
  };

  if (variant === 'icon') {
    return (
      <div 
        className={`flex items-center justify-center p-2 rounded-full hover:bg-gray-100 cursor-pointer transition-colors ${className}`}
        title={getStatusText()}
        onClick={isConnected? handleDisconnect : handleConnect}
      >
        {getStatusIcon()}
      </div>
    );
  }

  if (variant === 'badge') {
    return (
      <Badge
        variant={getStatusVariant() as any}
        className={`cursor-pointer hover:opacity-80 transition-opacity ${className}`}
        onClick={isConnected? handleDisconnect : handleConnect}
      >
        <div className="flex items-center space-x-1">
          {getStatusIcon()}
          <span className="text-xs">Backend</span>
        </div>
      </Badge>
    );
  }

  // Full variant
  return (
    <div className={`flex items-center justify-between p-3 border rounded-lg ${className}`}>
      <div className="flex items-center space-x-3">
        {getStatusIcon()}
        <div>
          <p className="text-sm font-medium">Backend Server</p>
          <p className="text-xs text-gray-500">{getStatusText()}</p>
        </div>
      </div>
      
      <div className="flex items-center space-x-2">
        {error && (
          <Button
            size="sm"
            variant="ghost"
            onClick={handleConnect}
            disabled={isConnecting}
            className="text-xs"
          >
            <RefreshCw className="h-3 w-3 mr-1" />
            Retry
          </Button>
        )}

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
            disabled={isConnecting}
          >
            {isConnecting ? 'Connecting...' : 'Connect'}
          </Button>
        )}
      </div>
    </div>
  );
};
