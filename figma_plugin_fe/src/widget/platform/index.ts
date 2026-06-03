// Runtime platform selection for worker compatibility
// This approach uses runtime detection instead of build-time aliases
// since workers bypass Vite's module resolution

import { PlatformEnvironment, detectEnvironment } from './IDesignPlatform';
import type { IDesignPlatform } from './IDesignPlatform';

async function createPlatform(): Promise<IDesignPlatform> {
  const environment = detectEnvironment();
  console.log(`[PLATFORM] Detected environment: ${environment}`);
  
  switch (environment) {
    case PlatformEnvironment.DEV: {
      const { DevImplementation } = await import('./implementations/DevImplementation');
      return new DevImplementation();
    }
    case PlatformEnvironment.FIGMA: {
      const { FigmaImplementation } = await import('./implementations/FigmaImplementation');
      return new FigmaImplementation();
    }
    case PlatformEnvironment.PENPOT: {
      const { PenpotImplementation } = await import('./implementations/PenpotImplementation');
      return new PenpotImplementation();
    }
    default:
      throw new Error(`Unsupported platform environment: ${environment}`);
  }
}

// Export platform creation function instead of using top-level await
let platformInstance: IDesignPlatform | null = null;

export const platform = {
  async getInstance(): Promise<IDesignPlatform> {
    if (!platformInstance) {
      platformInstance = await createPlatform();
    }
    return platformInstance;
  }
};

// Re-export types for convenience
export type { IDesignPlatform } from './IDesignPlatform';
