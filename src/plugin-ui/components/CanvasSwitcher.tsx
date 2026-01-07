/**
 * CanvasSwitcher Component
 *
 * Wrapper component that allows switching between PixiJS and Skia (CanvasKit) renderers.
 * Provides a toggle button to compare the two rendering engines.
 */

import React, { useState, useCallback } from 'react';
import { PixiCanvas } from './PixiCanvas';
import { SkiaCanvas } from './SkiaCanvas';

export type RendererType = 'pixi' | 'skia';

interface CanvasSwitcherProps {
    /** Initial renderer to use */
    defaultRenderer?: RendererType;
    /** Content for top-right overlay */
    topRightContent?: React.ReactNode;
    /** Content for bottom-right overlay */
    bottomRightContent?: React.ReactNode;
    /** Content for center-right overlay */
    centerRightContent?: React.ReactNode;
    /** Content for top-left overlay */
    topLeftContent?: React.ReactNode;
    /** Called when renderer is switched */
    onRendererChange?: (renderer: RendererType) => void;
}

/**
 * CanvasSwitcher - Toggle between Pixi and Skia renderers
 *
 * @example
 * ```tsx
 * <CanvasSwitcher
 *   defaultRenderer="pixi"
 *   topRightContent={<ToolPanel />}
 *   onRendererChange={(renderer) => console.log('Switched to:', renderer)}
 * />
 * ```
 */
export const CanvasSwitcher: React.FC<CanvasSwitcherProps> = ({
    defaultRenderer = 'pixi',
    topRightContent,
    bottomRightContent,
    centerRightContent,
    topLeftContent,
    onRendererChange,
}) => {
    const [currentRenderer, setCurrentRenderer] = useState<RendererType>(defaultRenderer);

    const handleToggle = useCallback(() => {
        const newRenderer: RendererType = currentRenderer === 'pixi' ? 'skia' : 'pixi';
        setCurrentRenderer(newRenderer);
        onRendererChange?.(newRenderer);
    }, [currentRenderer, onRendererChange]);

    // Common props for both canvas components
    const canvasProps = {
        topRightContent,
        bottomRightContent,
        centerRightContent,
        topLeftContent,
    };

    return (
        <div className="relative h-full w-full">
            {/* Render the active canvas */}
            {currentRenderer === 'pixi' ? (
                <PixiCanvas {...canvasProps} />
            ) : (
                <SkiaCanvas {...canvasProps} />
            )}

            {/* Renderer toggle button */}
            <div className="absolute top-4 left-4 z-20">
                <button
                    onClick={handleToggle}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white border border-gray-200 shadow-sm hover:bg-gray-50 transition-colors"
                    title={`Switch to ${currentRenderer === 'pixi' ? 'Skia' : 'PixiJS'} renderer`}
                >
                    {/* Toggle indicator */}
                    <div className="relative w-12 h-6 rounded-full bg-gray-200 transition-colors">
                        <div
                            className={`absolute top-1 w-4 h-4 rounded-full transition-all duration-200 ${currentRenderer === 'pixi'
                                ? 'left-1 bg-green-500'
                                : 'left-7 bg-purple-500'
                                }`}
                        />
                    </div>

                    {/* Labels */}
                    <div className="flex items-center gap-1 text-sm">
                        <span
                            className={`font-medium transition-colors ${currentRenderer === 'pixi' ? 'text-green-600' : 'text-gray-400'
                                }`}
                        >
                            Pixi
                        </span>
                        <span className="text-gray-300">/</span>
                        <span
                            className={`font-medium transition-colors ${currentRenderer === 'skia' ? 'text-purple-600' : 'text-gray-400'
                                }`}
                        >
                            Skia
                        </span>
                    </div>
                </button>
            </div>

            {/* Current renderer info badge */}
            <div className="absolute top-4 right-4 z-20">
                <div
                    className={`px-3 py-1.5 rounded-lg text-sm font-medium text-white shadow-sm ${currentRenderer === 'pixi' ? 'bg-green-500' : 'bg-purple-500'
                        }`}
                >
                    {currentRenderer === 'pixi' ? 'PixiJS (WebGL)' : 'Skia (CanvasKit WASM)'}
                </div>
            </div>
        </div>
    );
};

export default CanvasSwitcher;

