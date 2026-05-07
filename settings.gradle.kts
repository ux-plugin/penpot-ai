pluginManagement {
    repositories {
        mavenCentral()
        gradlePluginPortal()
        mavenLocal()
    }
}

rootProject.name = "figma-plugin"

include("core", "api", "sanitizer", "anonymizer", "processor")
