package com.plugin.features.completions

import com.fasterxml.jackson.annotation.*
import java.time.Instant

/** Database model for Component Completion */
data class ComponentCompletion(
    var userId: String,
    var id: String,
    var prompt: String,
    var aiCompletion: String,
    var createdAt: Instant,
)

enum class BlendMode(@JsonValue val value: String) {
    NORMAL("NORMAL"),
    MULTIPLY("MULTIPLY"),
    SCREEN("SCREEN"),
    OVERLAY("OVERLAY"),
    DARKEN("DARKEN"),
    LIGHTEN("LIGHTEN"),
    COLOR_DODGE("COLOR_DODGE"),
    COLOR_BURN("COLOR_BURN"),
    HARD_LIGHT("HARD_LIGHT"),
    SOFT_LIGHT("SOFT_LIGHT"),
    DIFFERENCE("DIFFERENCE"),
    EXCLUSION("EXCLUSION"),
    HUE("HUE"),
    SATURATION("SATURATION"),
    COLOR("COLOR"),
    LUMINOSITY("LUMINOSITY"),
}

enum class ScaleMode(@JsonValue val value: String) {
    FILL("FILL"),
    FIT("FIT"),
    CROP("CROP"),
    TILE("TILE"),
}

enum class StrokeJoin(@JsonValue val value: String) {
    MITER("MITER"),
    BEVEL("BEVEL"),
    ROUND("ROUND"),
}

enum class WindingRule(@JsonValue val value: String) {
    EVENODD("EVENODD"),
    NONZERO("NONZERO"),
    NONE("NONE"),
}

enum class StrokeCap(@JsonValue val value: String) {
    NONE("NONE"),
    ROUND("ROUND"),
    SQUARE("SQUARE"),
    ARROW_LINES("ARROW_LINES"),
    ARROW_EQUILATERAL("ARROW_EQUILATERAL"),
}

enum class MaskType(@JsonValue val value: String) {
    ALPHA("ALPHA"),
    VECTOR("VECTOR"),
    LUMINANCE("LUMINANCE"),
}

enum class ConstraintType(@JsonValue val value: String) {
    MIN("MIN"),
    CENTER("CENTER"),
    MAX("MAX"),
    STRETCH("STRETCH"),
    SCALE("SCALE"),
}

data class RGBA(val r: Float, val g: Float, val b: Float, val a: Float)

data class RGB(val r: Float, val g: Float, val b: Float)

typealias Transform = List<List<Float>>

@JsonInclude(JsonInclude.Include.NON_DEFAULT)
data class ImageFilters(
    val exposure: Float? = null,
    val contrast: Float? = null,
    val saturation: Float? = null,
    val temperature: Float? = null,
    val tint: Float? = null,
    val highlights: Float? = null,
    val shadows: Float? = null,
)

data class ColorStop(val position: Float, val color: RGBA)

@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.PROPERTY, property = "ty")
@JsonSubTypes(
    JsonSubTypes.Type(value = SolidPaint::class, name = "SOLID"),
    JsonSubTypes.Type(value = GradientPaintLinear::class, name = "GRADIENT_LINEAR"),
    JsonSubTypes.Type(value = GradientPaintRadial::class, name = "GRADIENT_RADIAL"),
    JsonSubTypes.Type(value = GradientPaintAngular::class, name = "GRADIENT_ANGULAR"),
    JsonSubTypes.Type(value = GradientPaintDiamond::class, name = "GRADIENT_DIAMOND"),
    JsonSubTypes.Type(value = ImagePaint::class, name = "IMAGE"),
    JsonSubTypes.Type(value = VideoPaint::class, name = "VIDEO"),
)
@JsonInclude(JsonInclude.Include.NON_DEFAULT)
abstract class PaintProps {
    abstract val blendMode: BlendMode?
    abstract val visible: Boolean?
    abstract val opacity: Float?
}

@JsonTypeName("VIDEO")
@JsonInclude(JsonInclude.Include.NON_DEFAULT)
data class VideoPaint(
    val videoHash: String,
    val videoTransform: Transform? = null,
    val scaleMode: ScaleMode,
    val scalingFactor: Int? = null,
    val rotation: Int? = null,
    val filters: ImageFilters? = null,
    override val blendMode: BlendMode? = null,
    override val visible: Boolean? = null,
    override val opacity: Float? = null,
) : PaintProps()

@JsonTypeName("GRADIENT_LINEAR")
@JsonInclude(JsonInclude.Include.NON_DEFAULT)
data class GradientPaintLinear(
    val gradientTransform: Transform,
    val gradientStops: List<ColorStop>,
    override val blendMode: BlendMode? = null,
    override val visible: Boolean? = null,
    override val opacity: Float? = null,
) : PaintProps()

@JsonTypeName("GRADIENT_RADIAL")
@JsonInclude(JsonInclude.Include.NON_DEFAULT)
data class GradientPaintRadial(
    val gradientTransform: Transform,
    val gradientStops: List<ColorStop>,
    override val blendMode: BlendMode? = null,
    override val visible: Boolean? = null,
    override val opacity: Float? = null,
) : PaintProps()

@JsonTypeName("GRADIENT_ANGULAR")
@JsonInclude(JsonInclude.Include.NON_DEFAULT)
data class GradientPaintAngular(
    val gradientTransform: Transform,
    val gradientStops: List<ColorStop>,
    override val blendMode: BlendMode? = null,
    override val visible: Boolean? = null,
    override val opacity: Float? = null,
) : PaintProps()

@JsonTypeName("GRADIENT_DIAMOND")
@JsonInclude(JsonInclude.Include.NON_DEFAULT)
data class GradientPaintDiamond(
    val gradientTransform: Transform,
    val gradientStops: List<ColorStop>,
    override val blendMode: BlendMode? = null,
    override val visible: Boolean? = null,
    override val opacity: Float? = null,
) : PaintProps()

@JsonTypeName("IMAGE")
@JsonInclude(JsonInclude.Include.NON_DEFAULT)
data class ImagePaint(
    val src: String,
    val imageHash: String,
    val scaleMode: ScaleMode,
    val imageTransform: Transform? = null,
    val scalingFactor: Int? = null,
    val rotation: Int? = null,
    override val blendMode: BlendMode? = null,
    override val visible: Boolean? = null,
    override val opacity: Float? = null,
) : PaintProps()

@JsonTypeName("SOLID")
@JsonInclude(JsonInclude.Include.NON_DEFAULT)
data class SolidPaint(
    val color: RGB,
    override val blendMode: BlendMode? = null,
    override val visible: Boolean? = null,
    override val opacity: Float? = null,
) : PaintProps()

data class Constraints(val horizontal: ConstraintType, val vertical: ConstraintType)

enum class StrokeAlign(@JsonValue val value: String) {
    CENTER("CENTER"),
    INSIDE("INSIDE"),
    OUTSIDE("OUTSIDE"),
}

enum class LayoutAlign(@JsonValue val value: String) {
    MIN("MIN"),
    CENTER("CENTER"),
    MAX("MAX"),
    STRETCH("STRETCH"),
    INHERIT("INHERIT"),
}

enum class LayoutPositioning(@JsonValue val value: String) {
    AUTO("AUTO"),
    ABSOLUTE("ABSOLUTE"),
}

enum class LayoutSizing(@JsonValue val value: String) {
    FIXED("FIXED"),
    HUG("HUG"),
    FILL("FILL"),
}

data class Vector(val x: Int, val y: Int)

@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.PROPERTY, property = "ty")
@JsonSubTypes(
    JsonSubTypes.Type(value = DropShadowEffect::class, name = "DROP_SHADOW"),
    JsonSubTypes.Type(value = InnerShadowEffect::class, name = "INNER_SHADOW"),
    JsonSubTypes.Type(value = BackgroundBlurEffect::class, name = "BACKGROUND_BLUR"),
    JsonSubTypes.Type(value = LayerBlurEffect::class, name = "LAYER_BLUR"),
)
abstract class Effect {
    abstract val visible: Boolean
}

@JsonTypeName("DROP_SHADOW")
@JsonInclude(JsonInclude.Include.NON_DEFAULT)
data class DropShadowEffect(
    val color: RGBA,
    val offset: Vector,
    val radius: Int,
    val spread: Int? = null,
    override val visible: Boolean,
    val blendMode: BlendMode,
    val showShadowBehindNode: Boolean? = null,
) : Effect()

@JsonTypeName("INNER_SHADOW")
@JsonInclude(JsonInclude.Include.NON_DEFAULT)
data class InnerShadowEffect(
    val color: RGBA,
    val offset: Vector,
    val radius: Int,
    val spread: Int? = null,
    override val visible: Boolean,
    val blendMode: BlendMode,
) : Effect()

@JsonTypeName("BACKGROUND_BLUR")
data class BackgroundBlurEffect(val radius: Int, override val visible: Boolean) : Effect()

@JsonTypeName("LAYER_BLUR") data class LayerBlurEffect(val radius: Int, override val visible: Boolean) : Effect()

data class VectorPath(val windingRule: WindingRule, val data: String)

data class StrokeWeight(
    val strokeTopWeight: Float,
    val strokeBottomWeight: Float,
    val strokeLeftWeight: Float,
    val strokeRightWeight: Float,
)

data class CornerRadius(
    val topLeftRadius: Int,
    val topRightRadius: Int,
    val bottomLeftRadius: Int,
    val bottomRightRadius: Int,
)

@JsonInclude(JsonInclude.Include.NON_DEFAULT, content = JsonInclude.Include.NON_EMPTY)
data class FrameNode(
    val id: String = "",
    val name: String? = null,
    val clipsContent: Boolean? = null,
    val children: List<String>? = emptyList(),
    val parent: String? = null,
    val fills: List<PaintProps>? = emptyList(),
    val fillStyleId: List<String>? = emptyList(),
    val strokes: List<PaintProps>? = emptyList(),
    val strokeStyleId: String? = null,
    val strokeWeight: StrokeWeight? = null, // Can be Int or StrokeJoin
    val strokeJoin: StrokeJoin? = null,
    val strokeAlign: StrokeAlign? = null,
    val dashPattern: List<Int>? = emptyList(),
    val strokeGeometry: List<VectorPath>? = emptyList(),
    val strokeCap: StrokeCap? = null,
    val strokeMiterLimit: Int? = null,
    val fillGeometry: List<VectorPath>? = emptyList(),
    val cornerRadius: CornerRadius? = null,
    val cornerSmoothing: Int? = null,
    val opacity: Float? = null,
    val blendMode: BlendMode? = null,
    val isMask: Boolean? = null,
    val maskType: MaskType? = null,
    val effects: List<Effect>? = emptyList(),
    val effectStyleId: String? = null,
    val x: Int? = null,
    val y: Int? = null,
    val width: Int? = null,
    val height: Int? = null,
    val minWidth: Int? = null,
    val maxWidth: Int? = null,
    val minHeight: Int? = null,
    val maxHeight: Int? = null,
    val layoutAlign: LayoutAlign? = null,
    val layoutGrow: Float? = null,
    val layoutPositioning: LayoutPositioning? = null,
    val constrainProportions: Boolean? = null,
    val rotation: Int? = null,
    val layoutSizingHorizontal: LayoutSizing? = null,
    val layoutSizingVertical: LayoutSizing? = null,
    val constraints: Constraints? = null,
)
