/**
 * NodeSprite Component
 *
 * Handles SVG node rendering as PixiJS Sprites.
 * Creates textures from SVG data and renders them as sprites.
 */

import { Sprite, Assets, Texture } from 'pixi.js';
import type { AbsoluteNode } from '@/plugin-ui/utils/pixiNodeRenderer';
import { figmaToPixiBlendMode } from '@/plugin-ui/utils/pixiNodeRenderer';

/**
 * Load SVG texture from string or Uint8Array
 */
export async function loadSVGTexture(
  svg: string | Uint8Array
): Promise<Texture> {
  const svgString =
    typeof svg === 'string' ? svg : new TextDecoder().decode(svg);

  // Validate SVG string
  if (!svgString || svgString.trim().length === 0) {
    throw new Error('Empty or invalid SVG string');
  }

  // Create blob URL from SVG
  const svgBlob = new Blob([svgString], {
    type: 'image/svg+xml;charset=utf-8',
  });
  const url = URL.createObjectURL(svgBlob);

  try {
    // Method 1: Try Assets.load first (works in most cases)
    try {
      const result = await Assets.load(url);

      // Handle both cases: Resource object with texture property, or Texture directly
      let texture: Texture | null = null;
      if (result instanceof Texture) {
        texture = result;
      } else if (result && typeof result === 'object') {
        // Check for texture property (Resource object)
        if ('texture' in result && result.texture instanceof Texture) {
          texture = result.texture;
        } else if ('resource' in result && result.resource instanceof Texture) {
          texture = result.resource;
        } else if ('source' in result && result.source) {
          // Try to create texture from source
          texture = Texture.from(result.source);
        }
      }

      if (texture) {
        return texture;
      }
    } catch (assetsError) {
      console.warn('[NodeSprite] Assets.load failed, trying fallback:', assetsError);
    }

    // Method 2: Fallback - Create Image element and load SVG into it
    return new Promise<Texture>((resolve, reject) => {
      const img = new Image();

      img.onload = () => {
        try {
          const texture = Texture.from(img);
          if (texture) {
            resolve(texture);
          } else {
            reject(new Error('Texture.from returned null'));
          }
        } catch (error) {
          reject(error);
        }
      };

      img.onerror = (error) => {
        reject(new Error(`Failed to load SVG image: ${error}`));
      };

      img.src = url;
    });
  } catch (error) {
    console.error('[NodeSprite] Failed to load SVG texture:', error);
    throw error;
  } finally {
    // Clean up blob URL after a delay to ensure texture is loaded
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 1000);
  }
}

/**
 * Create a sprite from an SVG node
 */
export async function createNodeSprite(
  node: AbsoluteNode,
  onClick?: (nodeId: string) => void
): Promise<Sprite | null> {
  const { width, height, data } = node;

  // Only create sprite for SVG render mode with svg data
  if (data.renderMode !== 'svg' || !data.svg) {
    return null;
  }

  try {
    const texture = await loadSVGTexture(data.svg);

    // Validate texture before creating sprite
    if (!texture) {
      throw new Error('Invalid texture returned from loadSVGTexture');
    }

    const sprite = new Sprite(texture);

    // Set dimensions
    sprite.width = width;
    sprite.height = height;

    // Apply transformations
    sprite.x = node.absoluteX;
    sprite.y = node.absoluteY;
    sprite.rotation = ((data.rotation || 0) * Math.PI) / 180;
    sprite.alpha = data.opacity ?? 1;

    // Apply blend mode
    if (data.blendMode && typeof data.blendMode === 'string') {
      const blendMode = figmaToPixiBlendMode[data.blendMode];
      if (blendMode) {
        sprite.blendMode = blendMode;
      }
    }

    // Make interactive
    sprite.eventMode = 'static';
    sprite.cursor = 'pointer';
    sprite.label = node.id;

    // Click handler
    if (onClick) {
      sprite.on('pointerdown', () => onClick(node.id));
    }

    // Hover effect
    const originalAlpha = data.opacity ?? 1;
    sprite.on('pointerenter', () => {
      sprite.alpha = Math.max(0.7, originalAlpha - 0.2);
    });
    sprite.on('pointerleave', () => {
      sprite.alpha = originalAlpha;
    });

    return sprite;
  } catch (error) {
    console.error(`[NodeSprite] Failed to create sprite for node ${node.id}:`, error);
    return null;
  }
}

/**
 * Create a placeholder sprite when SVG loading fails
 */
export function createPlaceholderSprite(
  node: AbsoluteNode
): Sprite {
  const sprite = new Sprite(Texture.WHITE);
  sprite.width = node.width;
  sprite.height = node.height;
  sprite.x = node.absoluteX;
  sprite.y = node.absoluteY;
  sprite.tint = 0xf3f4f6;
  sprite.alpha = 0.5;
  sprite.label = `${node.id}-placeholder`;
  return sprite;
}

