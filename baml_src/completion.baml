class RGBA {
  r float
  g float
  b float
  a float
}

class RGB {
  r float
  g float
  b float
}

type Transform = float[][]

class ImageFilters {
  exposure float?
  contrast float?
  saturation float?
  temperature float?
  tint float?
  highlights float?
  shadows float?
}

class ColorStop {
  position float
  color RGBA
}

type ScaleMode = "FILL" | "FIT" | "CROP" | "TILE"

class VideoPaint {
  type "video"
  videoHash string
  videoTransform Transform?
  scaleMode ScaleMode
  scalingFactor int?
  rotation int?
  filters ImageFilters?
  blendMode BlendMode?
  visible bool?
  opacity float?
}

type GradientType = "GRADIENT_LINEAR" | "GRADIENT_RADIAL" | "GRADIENT_ANGULAR" | "GRADIENT_DIAMOND"

class GradientPaint {
  type GradientType
  gradientTransform Transform
  gradientStops ColorStop[]
  blendMode BlendMode?
  visible bool?
  opacity float?
}

class ImagePaint {
  type "IMAGE"
  src string
  imageHash string
  scaleMode ScaleMode
  imageTransform Transform?
  scalingFactor int?
  rotation int?
  blendMode BlendMode?
  visible bool?
  opacity float?
}

class SolidPaint {
  type "SOLID"
  color RGB
  blendMode BlendMode?
  visible bool?
  opacity float?
}

type Paint = SolidPaint | GradientPaint | ImagePaint | VideoPaint

type BlendMode = "NORMAL" | "MULTIPLY" | "SCREEN" | "OVERLAY" | "DARKEN" | "LIGHTEN" | "COLOR_DODGE" | "COLOR_BURN" | "HARD_LIGHT" | "SOFT_LIGHT" | "DIFFERENCE" | "EXCLUSION" | "HUE" | "SATURATION" | "COLOR" | "LUMINOSITY"

type WindingRule = "EVENODD" | "NONZERO" | "NONE"

type StrokeCap = "NONE" | "ROUND" | "SQUARE" | "ARROW_LINES" | "ARROW_EQUILATERAL"

type MaskType = "ALPHA" | "VECTOR" | "LUMINANCE"

type ConstraintType = "MIN" | "CENTER" | "MAX" | "STRETCH" | "SCALE"

class Constraints {
  horizontal ConstraintType
  vertical ConstraintType
}

class Vector {
  x int
  y int
}

class DropShadowEffect {
  type "DROP_SHADOW"
  color RGBA
  offset Vector
  radius int
  spread int?
  visible bool
  blendMode BlendMode
  showShadowBehindNode bool?
}

class InnerShadowEffect {
  type "INNER_SHADOW"
  color RGBA
  offset Vector
  radius int
  spread int?
  visible bool
  blendMode BlendMode
}

type BlurType = "LAYER_BLUR" | "BACKGROUND_BLUR"

class BlurEffect {
  type BlurType
  radius int
  visible bool
}

type Effect = DropShadowEffect | InnerShadowEffect | BlurEffect

class VectorPath {
  windingRule WindingRule
  data string
}

type StrokeJoin = "MITER" | "BEVEL" | "ROUND"

class StrokeWeight {
  strokeTopWeight float
  strokeBottomWeight float
  strokeLeftWeight float
  strokeRightWeight float
}

class CornerRadius {
  topLeftRadius int
  topRightRadius int
  bottomLeftRadius int
  bottomRightRadius int
}

type StrokeAlign = "CENTER" | "INSIDE" | "OUTSIDE"

type LayoutAlign = "MIN" | "CENTER" | "MAX" | "STRETCH" | "INHERIT"

type LayoutPositioning = "AUTO" | "ABSOLUTE"

type LayoutSizing = "FIXED" | "HUG" | "FILL"

class FrameNode {
  id string
  name string?
  clipsContent bool?
  children string[]?
  parent string?
  fills Paint[]?
  fillStyleId string[]?
  strokes Paint[]?
  strokeStyleId string?
  strokeWeight StrokeWeight?
  strokeJoin StrokeJoin?
  strokeAlign StrokeAlign?
  dashPattern int[]?
  strokeGeometry VectorPath[]?
  strokeCap StrokeCap?
  strokeMiterLimit float?
  fillGeometry VectorPath[]?
  cornerRadius CornerRadius?
  cornerSmoothing float?
  opacity float?
  blendMode BlendMode?
  isMask bool?
  maskType MaskType?
  effects Effect[]?
  effectStyleId string?
  x int?
  y int?
  width int?
  height int?
  minWidth int?
  maxWidth int?
  minHeight int?
  maxHeight int?
  layoutAlign LayoutAlign?
  layoutGrow float?
  layoutPositioning LayoutPositioning?
  constrainProportions bool?
  rotation int?
  layoutSizingHorizontal LayoutSizing?
  layoutSizingVertical LayoutSizing?
  constraints Constraints?
}

function GetFrameNode(prompt: string) -> FrameNode {
  client "openai/gpt-4o-mini"
  prompt #"
    {{ prompt }}

  Only include the properties that do not have a default value.
  Ignore empty lists also.
    {{ ctx.output_format }}
  "#
}

test create_a_button {
  functions [GetFrameNode]
  args {
    prompt #"
      Create a button with a drop shadow effect.
    "#
  }
}
