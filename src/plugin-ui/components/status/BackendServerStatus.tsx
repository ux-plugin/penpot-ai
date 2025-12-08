import React, { useEffect, useState } from 'react';
import { Button } from '@ui/button';
import { Badge } from '@ui/badge';
import { ServerWithWifiIcon } from '@assets/icons/ServerWithWifiIcon.tsx';
import { connectRSocket, disconnectRSocket, isRSocketConnected, onRSocketOpen, onRSocketClose } from '@api/rsocket.ts';

interface BackendServerStatusProps {
  variant?: 'icon' | 'full' | 'badge';
  className?: string;
}

export const BackendServerStatus: React.FC<BackendServerStatusProps> = ({ 
  variant = 'icon',
  className = ''
}) => {
  // Track RSocket connection state locally
  const [isConnected, setIsConnected] = useState<boolean>(isRSocketConnected());
  const [isConnecting, setIsConnecting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unsubOpen = onRSocketOpen(() => {
      setIsConnected(true);
      setIsConnecting(false);
      setError(null);
    });
    const unsubClose = onRSocketClose(() => {
      setIsConnected(false);
      setIsConnecting(false);
    });
    return () => {
      unsubOpen();
      unsubClose();
    };
  }, []);


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
    return 'Backend server disconnected';
  };

  const getErrorText = () => {
    return error ? `Error: ${error}` : null;
  };

  const getErrorSuggestion = () => {
    return (error && isConnected) ? 'Try disconnecting and reconnecting to resolve this issue' : null;
  };

  const getStatusVariant = () => {
    if (isConnecting) return 'secondary';
    if (isConnected) return 'default';
    return 'outline';
  };

  const handleConnect = async () => {
    setIsConnecting(true);
    setError(null);
    try {
      await connectRSocket();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to connect';
      console.error('Failed to connect to backend server:', e);
      setError(msg);
      setIsConnecting(false);
    }
  };

  const handleDisconnect = () => {
    disconnectRSocket();
  };

  if (variant === 'icon') {
    const errorText = getErrorText();
    const errorSuggestion = getErrorSuggestion();
    const tooltipText = [getStatusText(), errorText, errorSuggestion]
      .filter(Boolean)
      .join('\n');
    
    return (
      <div 
        className={`flex items-center justify-center p-2 rounded-full hover:bg-gray-100 cursor-pointer transition-colors ${className}`}
        title={tooltipText}
        onClick={isConnected? handleDisconnect : handleConnect}
      >
        {getStatusIcon()}
      </div>
    );
  }

  if (variant === 'badge') {
    const errorText = getErrorText();
    const errorSuggestion = getErrorSuggestion();
    const tooltipText = [getStatusText(), errorText, errorSuggestion]
      .filter(Boolean)
      .join('\n');
    
    return (
      <Badge
        variant={getStatusVariant() as any}
        className={`cursor-pointer hover:opacity-80 transition-opacity ${className}`}
        onClick={isConnected? handleDisconnect : handleConnect}
        title={tooltipText}
      >
        <div className="flex items-center space-x-1">
          {getStatusIcon()}
          <span className="text-xs">Backend</span>
        </div>
      </Badge>
    );
  }

  // Full variant
  const errorText = getErrorText();
  const errorSuggestion = getErrorSuggestion();
  
  return (
    <div className={`p-3 border rounded-lg ${className}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-3">
          {getStatusIcon()}
          <div>
            <p className="text-sm font-medium">Backend Server</p>
            <p className="text-xs text-gray-500">{getStatusText()}</p>
          </div>
        </div>
        
        <div className="flex items-center space-x-2">
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
      
      {errorText && (
        <p className="text-xs text-red-600 mt-2">{errorText}</p>
      )}
      {errorSuggestion && (
        <p className="text-xs text-amber-600 mt-1">{errorSuggestion}</p>
      )}
    </div>
  );
};
