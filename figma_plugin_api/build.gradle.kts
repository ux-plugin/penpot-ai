plugins {
    id("org.jetbrains.kotlin.jvm") version "2.1.20" apply false
    id("org.jetbrains.kotlin.plugin.allopen") version "2.1.20" apply false
    id("org.jetbrains.kotlin.plugin.serialization") version "2.1.20" apply false
    id("org.jetbrains.kotlin.plugin.spring") version "2.1.20" apply false
    id("org.jetbrains.kotlin.plugin.jpa") version "2.1.20" apply false
    id("org.springframework.boot") version "3.4.12" apply false
    id("io.spring.dependency-management") version "1.1.7" apply false
    id("com.diffplug.spotless") version "8.1.0"
}

allprojects {
    group = "com.plugin"
    version = "0.0.1"

    repositories {
        mavenCentral()
        mavenLocal()
    }
}

subprojects {
    apply(plugin = "com.diffplug.spotless")

    // Workaround for KT-66760: ensure the impl jar that supplies
    // ClasspathEntrySnapshotter$Settings is on the artifact-transform classpath.
    plugins.withId("org.jetbrains.kotlin.jvm") {
        dependencies {
            "compileOnly"("org.jetbrains.kotlin:kotlin-build-tools-impl:2.1.20")
        }
    }

    configure<com.diffplug.gradle.spotless.SpotlessExtension> {
        kotlin {
            target("src/**/*.kt")
            targetExclude("bin/**", "build/**")
            ktlint("1.4.0")
                .editorConfigOverride(
                    mapOf(
                        "ktlint_standard_no-wildcard-imports" to "disabled",
                        "ktlint_standard_no-empty-file" to "disabled",
                        "ktlint_standard_filename" to "disabled",
                        "ktlint_standard_value-parameter-comment" to "disabled",
                        "ktlint_standard_no-consecutive-comments" to "disabled",
                        "max_line_length" to "140",
                    ),
                )
        }
        kotlinGradle {
            target("*.gradle.kts")
            ktlint("1.4.0")
        }
    }

    tasks.matching { it.name == "check" }.configureEach {
        dependsOn("spotlessCheck")
    }
}
