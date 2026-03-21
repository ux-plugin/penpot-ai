// Viewport bounds interface
export interface ViewportBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Base interface for scene nodes across platforms
export interface BaseSceneNode {
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

// Import types from shared
import type { DesignNode } from "@/shared/types/types";

// Core interface that abstracts design platform APIs
export interface IDesignPlatform {
  // UI Communication
  ui: {
    onmessage: ((message: any) => void | Promise<void>) | null;
    postMessage: (message: any) => void;
    showUI: (
      html: string,
      options?: { width?: number; height?: number },
    ) => void;
    resize: (width: number, height: number) => void;
    reposition: (x: number, y: number) => void;
    getPosition: () => Promise<{
      windowSpace: { x: number; y: number };
      canvasSpace: { x: number; y: number };
    }>;
  };

  // Plugin Lifecycle
  closePlugin: () => void;

  // Node Management
  getNodeByIdAsync: (id: string) => Promise<any>;
  createFrame: () => any;
  createRectangle: () => any;
  getAllNodes: (includeSVG?: boolean) => Promise<DesignNode[]>;
  exportNodeSVGs?: (
    nodeIds: string[],
  ) => Promise<Array<{ nodeId: string; svg: string | null }>>;

  // Selection & Events
  currentPage: {
    /** Stable design surface page id (Figma: PageNode.id; dev stubs: empty). Used with translatePage / incremental changes. */
    readonly id: string;
    selection: readonly unknown[];
    children: readonly BaseSceneNode[];
    on: (
      event: string,
      callback: ((event?: any) => void) | (() => void),
    ) => void;
    /** Remove a listener from the current page (Figma); no-op where unsupported. */
    off?: (
      event: string,
      callback: ((event?: any) => void) | (() => void),
    ) => void;
  };
  on: (event: string, callback: ((event?: any) => void) | (() => void)) => void;

  // Viewport
  viewport: {
    bounds: ViewportBounds;
    zoom: number;
    center: { x: number; y: number };
  };

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
  FIGMA = "figma",
  DEV = "dev",
  PENPOT = "penpot",
}

export function detectEnvironment(): PlatformEnvironment {
  // Check if we're in a web worker (dev environment)
  if (
    typeof self !== "undefined" &&
    "postMessage" in self &&
    typeof window === "undefined"
  ) {
    return PlatformEnvironment.DEV;
  }

  // Check if figma global exists (Figma environment)
  if (typeof figma !== "undefined") {
    return PlatformEnvironment.FIGMA;
  }

  // Check if penpot global exists (future Penpot support)
  if (typeof (globalThis as any).penpot !== "undefined") {
    return PlatformEnvironment.PENPOT;
  }

  // Default to dev for fallback
  return PlatformEnvironment.DEV;
}
