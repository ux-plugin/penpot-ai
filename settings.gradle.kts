pluginManagement {
    repositories {
        mavenCentral()
        gradlePluginPortal()
        mavenLocal()
    }
}

rootProject.name = "figma-plugin"

include("core", "api", "anonymizer", "processor")
