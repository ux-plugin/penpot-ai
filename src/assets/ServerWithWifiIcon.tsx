import React from 'react';

type WifiState = 'connected' | 'connecting' | 'disconnected';

interface ServerWithWifiIconProps {
  wifiState: WifiState;
  className?: string;
  size?: number;
  strokeWidth?: number;
  connectedColor?: string;     // default green
  disconnectedColor?: string;  // default red
  neutralColor?: string;       // default gray
  title?: string;
}

export const ServerWithWifiIcon: React.FC<ServerWithWifiIconProps> = ({
                                                                        wifiState,
                                                                        className = '',
                                                                        size = 24,
                                                                        strokeWidth = 2,
                                                                        connectedColor = '#16a34a',     // green-600
                                                                        disconnectedColor = '#ef4444',  // red-500
                                                                        neutralColor = '#64748b',       // slate-500
                                                                        title = 'Server status',
                                                                      }) => {
  const isConnected = wifiState === 'connected';
  const isConnecting = wifiState === 'connecting';
  const isDisconnected = wifiState === 'disconnected';

  const aria = isConnected ? 'Connected' : isConnecting ? 'Connecting' : 'Disconnected';

  // Original server/cloud path from your component
  const serverPath =
    'M6.657 18C4.085 18 2 15.993 2 13.517c0-2.475 2.085-4.482 4.657-4.482c.393-1.762 1.794-3.2 3.675-3.773c1.88-.572 3.956-.193 5.444 1c1.488 1.19 2.162 3.007 1.77 4.769h.99c1.913 0 3.464 1.56 3.464 3.486c0 1.927-1.551 3.487-3.465 3.487H6.657';

  // Progress bar geometry (inside the cloud footprint)
  const bar = {
    x0: 6.5,
    x1: 17.5,
    y: 13.4,
    h: 2.0,
    r: 1.0,
    wSegment: 5.0, // moving capsule width
  };

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label={`${title}: ${aria}`}
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    >
      {title ? <title>{`${title}: ${aria}`}</title> : null}

      {/* Connected: green server (stroke + subtle glow) */}
      {isConnected && (
        <g>
          {/* Subtle glow via wider, faint stroke */}
          <path
            d={serverPath}
            stroke={connectedColor}
            strokeWidth={strokeWidth * 2.4}
            strokeOpacity={0.18}
          />
          <path
            d={serverPath}
            stroke={connectedColor}
            strokeWidth={strokeWidth}
          />
        </g>
      )}

      {/* Connecting: neutral server with pulsing outline + progress bar */}
      {isConnecting && (
        <g>
          {/* Base outline with pulse */}
          <path
            d={serverPath}
            stroke={neutralColor}
            strokeWidth={strokeWidth}
            strokeOpacity={0.9}
          >
            <animate
              attributeName="stroke-opacity"
              values="0.9;0.45;0.9"
              dur="1.4s"
              repeatCount="indefinite"
            />
          </path>

          {/* Moving capsule progress bar */}
          <rect
            x={bar.x0}
            y={bar.y}
            width={bar.wSegment}
            height={bar.h}
            rx={bar.r}
            fill={connectedColor}
            opacity={0.9}
          >
            <animate
              attributeName="x"
              values={`${bar.x0};${bar.x1 - bar.wSegment};${bar.x0}`}
              dur="1.6s"
              repeatCount="indefinite"
            />
            <animate
              attributeName="opacity"
              values="0.5;1;0.5"
              dur="1.6s"
              repeatCount="indefinite"
            />
          </rect>
        </g>
      )}

      {/* Disconnected: neutral server with red slash */}
      {isDisconnected && (
        <g>
          <path
            d={serverPath}
            stroke={neutralColor}
            strokeWidth={strokeWidth}
          />
          <line
            x1={5.5}
            y1={8}
            x2={19}
            y2={19}
            stroke={disconnectedColor}
            strokeWidth={strokeWidth * 1.6}
            strokeLinecap="round"
          />
        </g>
      )}
    </svg>
  );
};
