// Core interface that abstracts design platform APIs
export interface IDesignPlatform {
  // UI Communication
  ui: {
    onmessage: ((message: any) => void | Promise<void>) | null;
    postMessage: (message: any) => void;
    showUI: (html: string, options?: { width?: number; height?: number }) => void;
    resize: (width: number, height: number) => void;
  };
  
  // Plugin Lifecycle
  closePlugin: () => void;
  
  // Node Management
  getNodeByIdAsync: (id: string) => Promise<any>;
  createFrame: () => any;
  createRectangle: () => any;
  
  // Selection & Events
  currentPage: {
    selection: readonly unknown[];
  };
  on: (event: string, callback: () => void) => void;
  
  // Styles
  getStyleByIdAsync: (id: string) => Promise<any>;
  
  // Storage
  storage: {
    setAsync: (key: string, value: any) => Promise<void>;
    getAsync: (key: string) => Promise<any>;
    deleteAsync: (key: string) => Promise<void>;
  };
}

// Environment detection
export enum PlatformEnvironment {
  FIGMA = 'figma',
  DEV = 'dev', 
  PENPOT = 'penpot'
}

export function detectEnvironment(): PlatformEnvironment {
  // Check if we're in a web worker (dev environment)
  if (typeof self !== 'undefined' && 'postMessage' in self && typeof window === 'undefined') {
    return PlatformEnvironment.DEV;
  }
  
  // Check if figma global exists (Figma environment)
  if (typeof figma !== 'undefined') {
    return PlatformEnvironment.FIGMA;
  }
  
  // Check if penpot global exists (future Penpot support)
  if (typeof (globalThis as any).penpot !== 'undefined') {
    return PlatformEnvironment.PENPOT;
  }
  
  // Default to dev for fallback
  return PlatformEnvironment.DEV;
}