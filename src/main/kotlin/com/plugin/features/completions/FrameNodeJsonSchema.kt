package com.plugin.features.completions

import dev.langchain4j.model.chat.request.ResponseFormat
import dev.langchain4j.model.chat.request.ResponseFormatType
import dev.langchain4j.model.chat.request.json.*

// Reusable schema definitions
// Blend mode schema
val blendModeSchema: JsonSchemaElement = JsonEnumSchema.builder()
    .description("Blend mode for the paint or effect")
    .enumValues(
        "NORMAL", "MULTIPLY", "SCREEN", "OVERLAY", "DARKEN", "LIGHTEN",
        "COLOR_DODGE", "COLOR_BURN", "HARD_LIGHT", "SOFT_LIGHT", "DIFFERENCE",
        "EXCLUSION", "HUE", "SATURATION", "COLOR", "LUMINOSITY"
    )
    .build()

// RGB color schema
val rgbColorSchema: JsonSchemaElement = JsonObjectSchema.builder()
    .description("RGB color values (float)")
    .addNumberProperty("r", "Red component (0-1)")
    .addNumberProperty("g", "Green component (0-1)")
    .addNumberProperty("b", "Blue component (0-1)")
    .required("r", "g", "b")
    .build()

// RGBA color schema
val rgbaColorSchema: JsonSchemaElement = JsonObjectSchema.builder()
    .description("RGBA color values (float)")
    .addNumberProperty("r", "Red component (0-1)")
    .addNumberProperty("g", "Green component (0-1)")
    .addNumberProperty("b", "Blue component (0-1)")
    .addNumberProperty("a", "Alpha component (0-1)")
    .required("r", "g", "b", "a")
    .build()

// Vector schema
val vectorSchema: JsonSchemaElement = JsonObjectSchema.builder()
    .description("2D vector with x and y coordinates")
    .addIntegerProperty("x", "X coordinate")
    .addIntegerProperty("y", "Y coordinate")
    .required("x", "y")
    .build()

// Vector path schema
val vectorPathSchema: JsonSchemaElement = JsonObjectSchema.builder()
    .description("Vector path definition")
    .addProperty(
        "windingRule", JsonEnumSchema.builder()
            .description("Winding rule for the path")
            .enumValues("EVENODD", "NONZERO", "NONE")
            .build()
    )
    .addStringProperty("data", "SVG path data")
    .required("windingRule", "data")
    .build()

// Color stop schema
val colorStopSchema: JsonSchemaElement = JsonObjectSchema.builder()
    .description("Color stop for gradients")
    .addNumberProperty("position", "Position of the color stop (0-1)")
    .addProperty("color", rgbaColorSchema)
    .required("position", "color")
    .build()

// Paint schemas
// Solid paint schema
val solidPaintSchema: JsonSchemaElement = JsonObjectSchema.builder()
    .description("Solid color paint")
    .addStringProperty("ty", "Type of paint (SOLID)")
    .addProperty("color", rgbColorSchema)
    .addProperty("blendMode", blendModeSchema)
    .addBooleanProperty("visible", "Whether the paint is visible")
    .addNumberProperty("opacity", "Opacity value between 0 and 1")
    .required("ty", "color")
    .build()

// Linear gradient paint schema
val linearGradientPaintSchema: JsonSchemaElement = JsonObjectSchema.builder()
    .description("Linear gradient paint")
    .addStringProperty("ty", "Type of paint (GRADIENT_LINEAR)")
    .addProperty(
        "gradientTransform", JsonArraySchema.builder()
            .description("Transformation matrix for the gradient")
            .items(
                JsonArraySchema.builder()
                    .items(JsonNumberSchema.builder().build())
                    .build()
            )
            .build()
    )
    .addProperty(
        "gradientStops", JsonArraySchema.builder()
            .description("Color stops for the gradient")
            .items(colorStopSchema)
            .build()
    )
    .addProperty("blendMode", blendModeSchema)
    .addBooleanProperty("visible", "Whether the paint is visible")
    .addNumberProperty("opacity", "Opacity value between 0 and 1")
    .required("ty", "gradientTransform", "gradientStops")
    .build()

// Radial gradient paint schema
val radialGradientPaintSchema: JsonSchemaElement = JsonObjectSchema.builder()
    .description("Radial gradient paint")
    .addStringProperty("ty", "Type of paint (GRADIENT_RADIAL)")
    .addProperty(
        "gradientTransform", JsonArraySchema.builder()
            .description("Transformation matrix for the gradient")
            .items(
                JsonArraySchema.builder()
                    .items(JsonNumberSchema.builder().build())
                    .build()
            )
            .build()
    )
    .addProperty(
        "gradientStops", JsonArraySchema.builder()
            .description("Color stops for the gradient")
            .items(colorStopSchema)
            .build()
    )
    .addProperty("blendMode", blendModeSchema)
    .addBooleanProperty("visible", "Whether the paint is visible")
    .addNumberProperty("opacity", "Opacity value between 0 and 1")
    .required("ty", "gradientTransform", "gradientStops")
    .build()

// Image paint schema
val imagePaintSchema: JsonSchemaElement = JsonObjectSchema.builder()
    .description("Image paint")
    .addStringProperty("ty", "Type of paint (IMAGE)")
    .addStringProperty("src", "Image source URL")
    .addStringProperty("imageHash", "Hash of the image")
    .addProperty(
        "scaleMode", JsonEnumSchema.builder()
            .description("Scale mode for the image")
            .enumValues("FILL", "FIT", "CROP", "TILE")
            .build()
    )
    .addProperty(
        "imageTransform", JsonArraySchema.builder()
            .description("Transformation matrix for the image")
            .items(
                JsonArraySchema.builder()
                    .items(JsonNumberSchema.builder().build())
                    .build()
            )
            .build()
    )
    .addIntegerProperty("scalingFactor", "Scaling factor for the image")
    .addIntegerProperty("rotation", "Rotation angle in degrees")
    .addProperty("blendMode", blendModeSchema)
    .addBooleanProperty("visible", "Whether the paint is visible")
    .addNumberProperty("opacity", "Opacity value between 0 and 1")
    .required("ty", "src", "imageHash", "scaleMode")
    .build()

// Combined paint schema using anyOf
val paintSchema: JsonSchemaElement = JsonAnyOfSchema.builder()
    .description("Paint can be one of several types")
    .anyOf(solidPaintSchema, linearGradientPaintSchema, radialGradientPaintSchema, imagePaintSchema)
    .build()

// Effect schemas
// Drop shadow effect schema
val dropShadowEffectSchema: JsonSchemaElement = JsonObjectSchema.builder()
    .description("Drop shadow effect")
    .addStringProperty("ty", "Type of effect (DROP_SHADOW)")
    .addProperty("color", rgbaColorSchema)
    .addProperty("offset", vectorSchema)
    .addIntegerProperty("radius", "Blur radius")
    .addIntegerProperty("spread", "Shadow spread")
    .addBooleanProperty("visible", "Whether the effect is visible")
    .addProperty("blendMode", blendModeSchema)
    .addBooleanProperty("showShadowBehindNode", "Whether to show shadow behind the node")
    .required("ty", "color", "offset", "radius", "visible", "blendMode")
    .build()

// Inner shadow effect schema
val innerShadowEffectSchema: JsonSchemaElement = JsonObjectSchema.builder()
    .description("Inner shadow effect")
    .addStringProperty("ty", "Type of effect (INNER_SHADOW)")
    .addProperty("color", rgbaColorSchema)
    .addProperty("offset", vectorSchema)
    .addIntegerProperty("radius", "Blur radius")
    .addIntegerProperty("spread", "Shadow spread")
    .addBooleanProperty("visible", "Whether the effect is visible")
    .addProperty("blendMode", blendModeSchema)
    .required("ty", "color", "offset", "radius", "visible", "blendMode")
    .build()

// Background blur effect schema
val backgroundBlurEffectSchema: JsonSchemaElement = JsonObjectSchema.builder()
    .description("Background blur effect")
    .addStringProperty("ty", "Type of effect (BACKGROUND_BLUR)")
    .addIntegerProperty("radius", "Blur radius")
    .addBooleanProperty("visible", "Whether the effect is visible")
    .required("ty", "radius", "visible")
    .build()

// Layer blur effect schema
val layerBlurEffectSchema: JsonSchemaElement = JsonObjectSchema.builder()
    .description("Layer blur effect")
    .addStringProperty("ty", "Type of effect (LAYER_BLUR)")
    .addIntegerProperty("radius", "Blur radius")
    .addBooleanProperty("visible", "Whether the effect is visible")
    .required("ty", "radius", "visible")
    .build()

// Combined effect schema using anyOf
val effectSchema: JsonSchemaElement = JsonAnyOfSchema.builder()
    .description("Effect can be one of several types")
    .anyOf(dropShadowEffectSchema, innerShadowEffectSchema, backgroundBlurEffectSchema, layerBlurEffectSchema)
    .build()

// Stroke weight schema
val strokeWeightSchema: JsonSchemaElement = JsonObjectSchema.builder()
    .description("Stroke weights for each side")
    .addNumberProperty("strokeTopWeight", "Top stroke weight")
    .addNumberProperty("strokeBottomWeight", "Bottom stroke weight")
    .addNumberProperty("strokeLeftWeight", "Left stroke weight")
    .addNumberProperty("strokeRightWeight", "Right stroke weight")
    .required("strokeTopWeight", "strokeBottomWeight", "strokeLeftWeight", "strokeRightWeight")
    .build()

// Corner radius schema
val cornerRadiusSchema: JsonSchemaElement = JsonObjectSchema.builder()
    .description("Corner radius for each corner")
    .addIntegerProperty("topLeftRadius", "Top left corner radius")
    .addIntegerProperty("topRightRadius", "Top right corner radius")
    .addIntegerProperty("bottomLeftRadius", "Bottom left corner radius")
    .addIntegerProperty("bottomRightRadius", "Bottom right corner radius")
    .required("topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius")
    .build()

// Constraints schema
val constraintsSchema: JsonSchemaElement = JsonObjectSchema.builder()
    .description("Layout constraints")
    .addProperty(
        "horizontal", JsonEnumSchema.builder()
            .description("Horizontal constraint type")
            .enumValues("MIN", "CENTER", "MAX", "STRETCH", "SCALE")
            .build()
    )
    .addProperty(
        "vertical", JsonEnumSchema.builder()
            .description("Vertical constraint type")
            .enumValues("MIN", "CENTER", "MAX", "STRETCH", "SCALE")
            .build()
    )
    .required("horizontal", "vertical")
    .build()

// Main FrameNode schema
val frameNodeJsonSchema: ResponseFormat = ResponseFormat.builder()
    .type(ResponseFormatType.JSON)
    .jsonSchema(
        JsonSchema.builder()
            .name("FrameNode")
            .rootElement(
                JsonObjectSchema.builder()
                    // String properties
                    .addStringProperty("id", "Unique identifier for the frame node")
                    .addStringProperty("name", "Name of the frame node")
                    .addStringProperty("strokeStyleId", "ID reference to a stroke style")
                    .addStringProperty("effectStyleId", "ID reference to an effect style")
                    .addStringProperty("parent", "ID of the parent node")

                    // Boolean properties
                    .addBooleanProperty("clipsContent", "Whether the frame clips its content")
                    .addBooleanProperty("isMask", "Whether the node is a mask")
                    .addBooleanProperty("constrainProportions", "Whether to constrain proportions")

                    // Number properties
                    .addNumberProperty("opacity", "Opacity value between 0 and 1")
                    .addNumberProperty("layoutGrow", "Layout grow factor")

                    // Integer properties
                    .addIntegerProperty("strokeMiterLimit", "Stroke miter limit")
                    .addIntegerProperty("cornerSmoothing", "Corner smoothing value")
                    .addIntegerProperty("x", "X position of the frame")
                    .addIntegerProperty("y", "Y position of the frame")
                    .addIntegerProperty("width", "Width of the frame")
                    .addIntegerProperty("height", "Height of the frame")
                    .addIntegerProperty("minWidth", "Minimum width of the frame")
                    .addIntegerProperty("maxWidth", "Maximum width of the frame")
                    .addIntegerProperty("minHeight", "Minimum height of the frame")
                    .addIntegerProperty("maxHeight", "Maximum height of the frame")
                    .addIntegerProperty("rotation", "Rotation angle in degrees")

                    // Enum properties
                    .addProperty(
                        "strokeJoin", JsonEnumSchema.builder()
                            .description("Type of stroke join")
                            .enumValues("MITER", "BEVEL", "ROUND")
                            .build()
                    )

                    .addProperty(
                        "strokeAlign", JsonEnumSchema.builder()
                            .description("Alignment of the stroke")
                            .enumValues("CENTER", "INSIDE", "OUTSIDE")
                            .build()
                    )

                    .addProperty(
                        "strokeCap", JsonEnumSchema.builder()
                            .description("Type of stroke cap")
                            .enumValues("NONE", "ROUND", "SQUARE", "ARROW_LINES", "ARROW_EQUILATERAL")
                            .build()
                    )

                    .addProperty("blendMode", blendModeSchema)

                    .addProperty(
                        "maskType", JsonEnumSchema.builder()
                            .description("Type of mask")
                            .enumValues("ALPHA", "VECTOR", "LUMINANCE")
                            .build()
                    )

                    .addProperty(
                        "layoutAlign", JsonEnumSchema.builder()
                            .description("Layout alignment")
                            .enumValues("MIN", "CENTER", "MAX", "STRETCH", "INHERIT")
                            .build()
                    )

                    .addProperty(
                        "layoutPositioning", JsonEnumSchema.builder()
                            .description("Layout positioning")
                            .enumValues("AUTO", "ABSOLUTE")
                            .build()
                    )

                    .addProperty(
                        "layoutSizingHorizontal", JsonEnumSchema.builder()
                            .description("Horizontal layout sizing")
                            .enumValues("FIXED", "HUG", "FILL")
                            .build()
                    )

                    .addProperty(
                        "layoutSizingVertical", JsonEnumSchema.builder()
                            .description("Vertical layout sizing")
                            .enumValues("FIXED", "HUG", "FILL")
                            .build()
                    )

                    // Array properties
                    .addProperty(
                        "children", JsonArraySchema.builder()
                            .description("List of child node IDs")
                            .items(JsonStringSchema.builder().build())
                            .build()
                    )

                    .addProperty(
                        "fillStyleId", JsonArraySchema.builder()
                            .description("List of fill style IDs")
                            .items(JsonStringSchema.builder().build())
                            .build()
                    )

                    .addProperty(
                        "dashPattern", JsonArraySchema.builder()
                            .description("Dash pattern for strokes")
                            .items(JsonIntegerSchema.builder().build())
                            .build()
                    )

                    // Complex object properties using references and anyOf
                    .addProperty(
                        "fills", JsonArraySchema.builder()
                            .description("List of fill paints")
                            .items(
                                paintSchema
                            )
                            .build()
                    )

                    .addProperty(
                        "strokes", JsonArraySchema.builder()
                            .description("List of stroke paints")
                            .items(
                                paintSchema
                            )
                            .build()
                    )

                    .addProperty(
                        "strokeWeight", strokeWeightSchema
                    )

                    .addProperty(
                        "cornerRadius", cornerRadiusSchema
                    )

                    .addProperty(
                        "constraints", constraintsSchema
                    )

                    .addProperty(
                        "strokeGeometry", JsonArraySchema.builder()
                            .description("Vector paths for stroke geometry")
                            .items(
                                vectorPathSchema
                            )
                            .build()
                    )

                    .addProperty(
                        "fillGeometry", JsonArraySchema.builder()
                            .description("Vector paths for fill geometry")
                            .items(
                                vectorPathSchema
                            )
                            .build()
                    )

                    .addProperty(
                        "effects", JsonArraySchema.builder()
                            .description("List of effects")
                            .items(
                                effectSchema
                            )
                            .build()
                    )

                    // Required fields
                    .required("id")
                    .build()
            )
            .build()
    )
    .build()
