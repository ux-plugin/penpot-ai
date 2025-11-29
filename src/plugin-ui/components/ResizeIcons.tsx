import React from 'react';

interface ResizeIconProps {
  className?: string;
}

/**
 * Resize icon for the bottom-right corner
 * Shows diagonal lines pointing to the bottom-right
 */
export const ResizeIconBottomRight: React.FC<ResizeIconProps> = ({ 
  className = "h-5 w-5" 
}) => {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      {/* Diagonal resize lines in bottom-right corner */}
      <g strokeLinecap="round" strokeWidth="1.5" stroke="currentColor">
        {/* Short line */}
        <line x1="16" y1="11" x2="11" y2="16" />
        {/* Medium line */}
        <line x1="16" y1="14" x2="14" y2="16" />
      </g>
    </svg>
  );
};

/**
 * Resize icon for the bottom-left corner
 * Shows diagonal lines pointing to the bottom-left
 */
export const ResizeIconBottomLeft: React.FC<ResizeIconProps> = ({ 
  className = "h-5 w-5" 
}) => {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      {/* Diagonal resize lines in bottom-left corner */}
      <g strokeLinecap="round" strokeWidth="1.5" stroke="currentColor">
        {/* Short line */}
        <line x1="4" y1="11" x2="9" y2="16" />
        {/* Medium line */}
        <line x1="4" y1="14" x2="6" y2="16" />
      </g>
    </svg>
  );
};

/**
 * Resize icon for the top-left corner
 * Shows diagonal lines pointing to the top-left
 */
export const ResizeIconTopLeft: React.FC<ResizeIconProps> = ({ 
  className = "h-5 w-5" 
}) => {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      {/* Diagonal resize lines in top-left corner */}
      <g strokeLinecap="round" strokeWidth="1.5" stroke="currentColor">
        {/* Short line */}
        <line x1="4" y1="9" x2="9" y2="4" />
        {/* Medium line */}
        <line x1="4" y1="6" x2="6" y2="4" />
      </g>
    </svg>
  );
};

/**
 * Resize icon for the top-right corner
 * Shows diagonal lines pointing to the top-right
 */
export const ResizeIconTopRight: React.FC<ResizeIconProps> = ({ 
  className = "h-5 w-5" 
}) => {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      {/* Diagonal resize lines in top-right corner */}
      <g strokeLinecap="round" strokeWidth="1.5" stroke="currentColor">
        {/* Short line */}
        <line x1="16" y1="9" x2="11" y2="4" />
        {/* Medium line */}
        <line x1="16" y1="6" x2="14" y2="4" />
      </g>
    </svg>
  );
};
