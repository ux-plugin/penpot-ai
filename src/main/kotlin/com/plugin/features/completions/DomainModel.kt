package com.plugin.features.completions

import com.fasterxml.jackson.annotation.JsonValue
import java.time.Instant

/**
 * Database model for Component Completion
 */
data class ComponentCompletion(
    var userId: String = "",
    var completionId: String = "",
    var prompt: String = "",
    var aiCompletion: String = "",
    var createdAt: Instant = Instant.now()
)

enum class BlendMode(@JsonValue val value: String) {
    NORMAL("NORMAL"), MULTIPLY("MULTIPLY"), SCREEN("SCREEN"), OVERLAY("OVERLAY"),
    DARKEN("DARKEN"), LIGHTEN("LIGHTEN"), COLOR_DODGE("COLOR_DODGE"), COLOR_BURN("COLOR_BURN"),
    HARD_LIGHT("HARD_LIGHT"), SOFT_LIGHT("SOFT_LIGHT"), DIFFERENCE("DIFFERENCE"), EXCLUSION("EXCLUSION"),
    HUE("HUE"), SATURATION("SATURATION"), COLOR("COLOR"), LUMINOSITY("LUMINOSITY")
}

enum class ScaleMode(@JsonValue val value: String) {
    FILL("FILL"), FIT("FIT"), CROP("CROP"), TILE("TILE")
}

enum class StrokeJoin(@JsonValue val value: String) {
    MITER("MITER"), BEVEL("BEVEL"), ROUND("ROUND")
}

enum class WindingRule(@JsonValue val value: String) {
    EVENODD("EVENODD"), NONZERO("NONZERO"), NONE("NONE")
}

enum class StrokeCap(@JsonValue val value: String) {
    NONE("NONE"), ROUND("ROUND"), SQUARE("SQUARE"),
    ARROW_LINES("ARROW_LINES"), ARROW_EQUILATERAL("ARROW_EQUILATERAL")
}

enum class MaskType(@JsonValue val value: String) {
    ALPHA("ALPHA"), VECTOR("VECTOR"), LUMINANCE("LUMINANCE")
}

enum class ConstraintType(@JsonValue val value: String) {
    MIN("MIN"), CENTER("CENTER"), MAX("MAX"), STRETCH("STRETCH"), SCALE("SCALE")
}

data class RGBA(
    val r: Float,
    val g: Float,
    val b: Float,
    val a: Float
)

data class RGB(
    val r: Float,
    val g: Float,
    val b: Float
)

typealias Transform = List<List<Float>>

data class ImageFilters(
    val exposure: Float? = null,
    val contrast: Float? = null,
    val saturation: Float? = null,
    val temperature: Float? = null,
    val tint: Float? = null,
    val highlights: Float? = null,
    val shadows: Float? = null
)

data class ColorStop(
    val position: Float,
    val color: RGBA
)

//@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.PROPERTY, property = "type")
//@JsonSubTypes(
//    JsonSubTypes.Type(value = SolidPaint::class, name = "solid"),
//    JsonSubTypes.Type(value = GradientPaintLinear::class, name = "gradient-linear"),
//    JsonSubTypes.Type(value = GradientPaintRadial::class, name = "gradient-radial"),
//    JsonSubTypes.Type(value = GradientPaintAngular::class, name = "gradient-angular"),
//    JsonSubTypes.Type(value = GradientPaintDiamond::class, name = "gradient-diamond"),
//    JsonSubTypes.Type(value = ImagePaint::class, name = "image"),
//    JsonSubTypes.Type(value = VideoPaint::class, name = "video")
//)
//abstract class PaintProps {
//    abstract val blendMode: BlendMode?
//    abstract val visible: Boolean?
//    abstract val opacity: Float?
//}

//@JsonTypeName("video")
//data class VideoPaint(
//    val videoHash: String,
//    val videoTransform: Transform? = null,
//    val scaleMode: ScaleMode,
//    val scalingFactor: Int? = null,
//    val rotation: Int? = null,
//    val filters: ImageFilters? = null,
//    override val blendMode: BlendMode? = null,
//    override val visible: Boolean? = null,
//    override val opacity: Float? = null
//) : PaintProps()
//
//@JsonTypeName("gradient-linear")
//data class GradientPaintLinear(
//    val gradientTransform: Transform,
//    val gradientStops: List<ColorStop>,
//    override val blendMode: BlendMode? = null,
//    override val visible: Boolean? = null,
//    override val opacity: Float? = null
//) : PaintProps()
//
//@JsonTypeName("gradient-radial")
//data class GradientPaintRadial(
//    val gradientTransform: Transform,
//    val gradientStops: List<ColorStop>,
//    override val blendMode: BlendMode? = null,
//    override val visible: Boolean? = null,
//    override val opacity: Float? = null
//) : PaintProps()
//
//@JsonTypeName("gradient-angular")
//data class GradientPaintAngular(
//    val gradientTransform: Transform,
//    val gradientStops: List<ColorStop>,
//    override val blendMode: BlendMode? = null,
//    override val visible: Boolean? = null,
//    override val opacity: Float? = null
//) : PaintProps()
//
//@JsonTypeName("gradient-diamond")
//data class GradientPaintDiamond(
//    val gradientTransform: Transform,
//    val gradientStops: List<ColorStop>,
//    override val blendMode: BlendMode? = null,
//    override val visible: Boolean? = null,
//    override val opacity: Float? = null
//) : PaintProps()
//
//@JsonTypeName("image")
//data class ImagePaint(
//    val src: String,
//    val imageHash: String,
//    val scaleMode: ScaleMode,
//    val imageTransform: Transform? = null,
//    val scalingFactor: Int? = null,
//    val rotation: Int? = null,
//    override val blendMode: BlendMode? = null,
//    override val visible: Boolean? = null,
//    override val opacity: Float? = null
//) : PaintProps()

//@JsonTypeName("solid")
data class SolidPaint(
    val color: RGB,
    val blendMode: BlendMode? = null,
    val visible: Boolean? = null,
    val opacity: Float? = null
)

data class Constraints(
    val horizontal: ConstraintType,
    val vertical: ConstraintType
)

enum class StrokeAlign(@JsonValue val value: String) {
    CENTER("CENTER"),
    INSIDE("INSIDE"),
    OUTSIDE("OUTSIDE")
}

enum class LayoutAlign(@JsonValue val value: String) {
    MIN("MIN"),
    CENTER("CENTER"),
    MAX("MAX"),
    STRETCH("STRETCH"),
    INHERIT("INHERIT")
}

enum class LayoutPositioning(@JsonValue val value: String) {
    AUTO("AUTO"),
    ABSOLUTE("ABSOLUTE")
}

enum class LayoutSizing(@JsonValue val value: String) {
    FIXED("FIXED"),
    HUG("HUG"),
    FILL("FILL")
}

data class Vector(
    val x: Int,
    val y: Int
)

//@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.PROPERTY, property = "type")
//@JsonSubTypes(
//    JsonSubTypes.Type(value = DropShadowEffect::class, name = "drop-shadow"),
//    JsonSubTypes.Type(value = InnerShadowEffect::class, name = "inner-shadow"),
//    JsonSubTypes.Type(value = BackgroundBlurEffect::class, name = "background-blur"),
//    JsonSubTypes.Type(value = LayerBlurEffect::class, name = "layer-blur")
//)
//abstract class Effect {
//    abstract val visible: Boolean
//}

//@JsonTypeName("DROP_SHADOW")
data class DropShadowEffect(
    val color: RGBA,
    val offset: Vector,
    val radius: Int,
    val spread: Int? = null,
    val visible: Boolean,
    val blendMode: BlendMode,
    val showShadowBehindNode: Boolean? = null
)

//@JsonTypeName("inner-shadow")
//data class InnerShadowEffect(
//    val color: RGBA,
//    val offset: Vector,
//    val radius: Int,
//    val spread: Int? = null,
//    override val visible: Boolean,
//    val blendMode: BlendMode
//) : Effect()
//
//@JsonTypeName("background-blur")
//data class BackgroundBlurEffect(
//    val radius: Int,
//    override val visible: Boolean
//) : Effect()
//
//@JsonTypeName("layer-blur")
//data class LayerBlurEffect(
//    val radius: Int,
//    override val visible: Boolean
//) : Effect()

data class VectorPath(
    val windingRule: WindingRule,
    val data: String
)

data class StrokeWeight(
    val strokeTopWeight: Float,
    val strokeBottomWeight: Float,
    val strokeLeftWeight: Float,
    val strokeRightWeight: Float
)

data class CornerRadius(
    val topLeftRadius: Int,
    val topRightRadius: Int,
    val bottomLeftRadius: Int,
    val bottomRightRadius: Int
)

data class FrameNode(
    val id: String,
    val name: String? = null,
    val clipsContent: Boolean? = null,
    val children: List<String>? = null,
    val parent: String? = null,
    val fills: List<SolidPaint>? = null,
    val fillStyleId: List<String>? = null,
    val strokes: List<SolidPaint>? = null,
    val strokeStyleId: String? = null,
    val strokeWeight: StrokeWeight? = null, // Can be Int or StrokeJoin
    val strokeJoin: StrokeJoin? = null,
    val strokeAlign: StrokeAlign? = null,
    val dashPattern: List<Int>? = null,
    val strokeGeometry: List<VectorPath>? = null,
    val strokeCap: StrokeCap? = null,
    val strokeMiterLimit: Int? = null,
    val fillGeometry: List<VectorPath>? = null,
    val cornerRadius: CornerRadius? = null,
    val cornerSmoothing: Int? = null,
    val opacity: Float? = null,
    val blendMode: BlendMode? = null,
    val isMask: Boolean? = null,
    val maskType: MaskType? = null,
    val effects: List<DropShadowEffect>? = null,
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
    val constraints: Constraints? = null
)

data class PromptRequest(val prompt: String, val userId: String)
