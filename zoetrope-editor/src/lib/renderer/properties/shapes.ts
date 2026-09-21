/**
 * Which bundles each shape type has, and the one-time registration.
 * Import this module (not the schemas) to get a populated registry.
 */

import type { ShapeType } from '../types'
import { registerBundle, registerShape, resetProperties } from './registry'
import { Appearance, appearanceAccessors } from './schemas/appearance'
import { Base } from './schemas/base'
import { Geometry } from './schemas/geometry'
import { Layout, LayoutItem } from './schemas/layout'
import { Modifier, modifierAccessors } from './schemas/modifier'
import { Radius } from './schemas/radius'
import { Material, Transform3D, materialAccessors, transform3dAccessors } from './schemas/scene3d'
import { Text, textAccessors } from './schemas/text'

const COMMON = ['base', 'geometry', 'appearance', 'layoutItem', 'modifier']

export const SHAPE_BUNDLES: Record<ShapeType, string[]> = {
  rect: [...COMMON, 'radius'],
  image: [...COMMON, 'radius'],
  frame: [...COMMON, 'radius', 'layout'],
  circle: COMMON,
  path: COMMON,
  bool: COMMON,
  'svg-raw': COMMON,
  group: ['base', 'geometry', 'appearance', 'layoutItem', 'modifier'],
  text: [...COMMON, 'text'],
  slot: ['base', 'geometry'],
}

let initialized = false

export function initDefaultProperties(): void {
  if (initialized) return
  registerBundle('base', Base)
  registerBundle('geometry', Geometry)
  registerBundle('appearance', Appearance, appearanceAccessors)
  registerBundle('radius', Radius)
  registerBundle('layout', Layout)
  registerBundle('layoutItem', LayoutItem)
  registerBundle('text', Text, textAccessors)
  registerBundle('modifier', Modifier, modifierAccessors)
  // Planned until the 3D lift makes objects nodes; bundles exist so ids resolve.
  registerBundle('transform3d', Transform3D, transform3dAccessors)
  registerBundle('material', Material, materialAccessors)
  for (const [type, ids] of Object.entries(SHAPE_BUNDLES)) registerShape(type as ShapeType, ids)
  initialized = true
}

/** Test helper: clear and re-register. */
export function reinitProperties(): void {
  resetProperties()
  initialized = false
  initDefaultProperties()
}

initDefaultProperties()
