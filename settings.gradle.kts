pluginManagement {
    val quarkusPluginVersion: String by settings
    val quarkusPluginId: String by settings
    repositories {
        mavenCentral()
        gradlePluginPortal()
        mavenLocal()
    }
    plugins {
        id(quarkusPluginId) version quarkusPluginVersion
    }
}

rootProject.name = "figma_plugin_api"

// Include the baml_client module
include(":baml_client")
project(":baml_client").projectDir = file("baml_client")
