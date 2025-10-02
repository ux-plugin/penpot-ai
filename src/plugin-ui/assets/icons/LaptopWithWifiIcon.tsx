import React from 'react';

type WifiState = 'connected' | 'connecting' | 'disconnected';

interface LaptopWithWifiIconProps {
  wifiState: WifiState;
  className?: string;
  size?: number;
  strokeWidth?: number;
  connectedColor?: string;     // default green
  disconnectedColor?: string;  // default red
  neutralColor?: string;       // default gray
  title?: string;
}

export const LaptopWithWifiIcon: React.FC<LaptopWithWifiIconProps> = ({
                                                                        wifiState,
                                                                        className = '',
                                                                        size = 24,
                                                                        strokeWidth = 1.2,
                                                                        connectedColor = '#16a34a',     // green-600
                                                                        disconnectedColor = '#ef4444',  // red-500
                                                                        neutralColor = '#64748b',       // slate-500
                                                                        title = 'Laptop status',
                                                                      }) => {
  const isConnected = wifiState === 'connected';
  const isConnecting = wifiState === 'connecting';
  const isDisconnected = wifiState === 'disconnected';

  const aria = isConnected ? 'Connected' : isConnecting ? 'Connecting' : 'Disconnected';

  // Screen area inside the original 15×15 silhouette (approx, with padding)
  const screen = { x: 2.5, y: 4.75, w: 10, h: 6 };
  const barW = 3.5;
  const barX0 = screen.x;
  const barX1 = screen.x + screen.w - barW;
  const barY = screen.y + screen.h / 2 - 0.6;

  // Original laptop silhouette path (unchanged)
  const laptopPath =
    'M2 4.25C2 4.11193 2.11193 4 2.25 4H12.75C12.8881 4 13 4.11193 13 4.25V11.5H2V4.25ZM2.25 3C1.55964 3 1 3.55964 1 4.25V12H0V12.5C0 12.7761 0.223858 13 0.5 13H14.5C14.7761 13 15 12.7761 15 12.5V12H14V4.25C14 3.55964 13.4404 3 12.75 3H2.25Z';

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 15 15"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label={`${title}: ${aria}`}
    >
      {title ? <title>{`${title}: ${aria}`}</title> : null}

      {/* Connected: solid green laptop */}
      {isConnected && (
        <g>
          <path d={laptopPath} fill={connectedColor} />
        </g>
      )}

      {/* Connecting: neutral laptop with pulsing outline + progress bar */}
      {isConnecting && (
        <g>
          {/* Base fill */}
          <path d={laptopPath} fill={neutralColor} fillOpacity="0.18" />
          {/* Outline pulse */}
          <path
            d={laptopPath}
            fill="none"
            stroke={neutralColor}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeOpacity={0.9}
          >
            <animate
              attributeName="stroke-opacity"
              values="0.9;0.45;0.9"
              dur="1.4s"
              repeatCount="indefinite"
            />
          </path>

          {/* Progress bar inside the screen */}
          <rect
            x={barX0}
            y={barY}
            width={barW}
            height={1.2}
            rx={0.6}
            fill={connectedColor}
            opacity={0.9}
          >
            <animate
              attributeName="x"
              values={`${barX0};${barX1};${barX0}`}
              dur="1.6s"
              repeatCount="indefinite"
            />
            <animate
              attributeName="opacity"
              values="0.4;1;0.4"
              dur="1.6s"
              repeatCount="indefinite"
            />
          </rect>
        </g>
      )}

      {/* Disconnected: neutral laptop with red slash */}
      {isDisconnected && (
        <g>
          <path d={laptopPath} fill={neutralColor} fillOpacity="0.16" />
          <path
            d={laptopPath}
            fill="none"
            stroke={neutralColor}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {/* Bar slash across the screen */}
          <line
            x1={2.2}
            y1={4.3}
            x2={12.8}
            y2={12.7}
            stroke={disconnectedColor}
            strokeWidth={strokeWidth * 1.7}
            strokeLinecap="round"
          />
        </g>
      )}
    </svg>
  );
};
