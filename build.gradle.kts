import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("org.jetbrains.kotlin.jvm") version "2.2.10"
    id("org.jetbrains.kotlin.plugin.allopen") version "2.2.10"
    id("org.jetbrains.kotlin.plugin.serialization") version "2.2.10"
    id("org.springframework.boot") version "3.4.12"
    id("io.spring.dependency-management") version "1.1.7"
    id("org.jetbrains.kotlin.plugin.spring") version "2.2.10"
    id("org.jetbrains.kotlin.plugin.jpa") version "2.2.10"
    id("com.diffplug.spotless") version "8.1.0"
}

repositories {
    mavenCentral()
    mavenLocal()
}

group = "com.plugin"

version = "0.0.1"

spotless {
    kotlin {
        target("src/**/*.kt") // Only target source files
        targetExclude("bin/**", "build/**") // Explicitly exclude build outputs
        ktlint("1.4.0")
            .editorConfigOverride(
                mapOf(
                    // Allow wildcard imports (IntelliJ default behavior)
                    "ktlint_standard_no-wildcard-imports" to "disabled",
                    // Allow empty files (common for stubs/placeholders during development)
                    "ktlint_standard_no-empty-file" to "disabled",
                    // Allow filename to differ from class name (useful for utility files, DTOs, etc.)
                    "ktlint_standard_filename" to "disabled",
                    // Allow inline parameter comments (useful for clarity)
                    "ktlint_standard_value-parameter-comment" to "disabled",
                    // Allow consecutive KDoc comments (common in API documentation)
                    "ktlint_standard_no-consecutive-comments" to "disabled",
                    // Optional: Set max line length (default is 120, can adjust)
                    "max_line_length" to "140",
                ),
            )
    }
    kotlinGradle {
        target("*.gradle.kts")
        ktlint("1.4.0")
    }
}

allOpen {
    annotation("org.springframework.stereotype.Component")
    annotation("org.springframework.stereotype.Service")
    annotation("org.springframework.web.bind.annotation.RestController")
    annotation("org.springframework.data.relational.core.mapping.Table")
    annotation("org.springframework.boot.test.context.SpringBootTest")
}

tasks.withType<Test> { useJUnitPlatform() }

dependencyManagement {
    imports {
        mavenBom("org.jetbrains.exposed:exposed-bom:1.0.0-rc-3")
        mavenBom("org.springframework.cloud:spring-cloud-dependencies:2024.0.0")
    }
}

dependencies {
    // Spring Boot starters
    implementation("org.springframework.boot:spring-boot-starter-webflux")
    implementation("org.springframework.boot:spring-boot-starter-rsocket")
    implementation("org.springframework.boot:spring-boot-starter-data-r2dbc")
    implementation("org.springframework.boot:spring-boot-starter-data-redis-reactive")
    implementation("org.springframework.boot:spring-boot-starter-security")
    implementation("org.springframework.security:spring-security-rsocket")
    implementation("org.springframework.boot:spring-boot-starter-actuator")
    implementation("org.springframework.boot:spring-boot-starter-validation")
    implementation("org.springframework.cloud:spring-cloud-starter")
    implementation("org.springframework.cloud:spring-cloud-context")

    // Kotlin exposed
    implementation("org.jetbrains.exposed:exposed-core")
    implementation("org.jetbrains.exposed:exposed-r2dbc")
    implementation("org.jetbrains.exposed:exposed-dao")
    implementation("org.jetbrains.exposed:exposed-java-time")

    // Kotlin support
    implementation("org.jetbrains.kotlin:kotlin-stdlib-jdk8")
    implementation("org.jetbrains.kotlin:kotlin-reflect")
    implementation("com.fasterxml.jackson.module:jackson-module-kotlin")
    implementation("io.projectreactor.kotlin:reactor-kotlin-extensions")

    // Kotlin coroutines
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.10.2")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-reactor:1.10.2")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.8.1")

    // Database
    implementation("org.postgresql:r2dbc-postgresql:1.0.7.RELEASE")
    implementation("org.liquibase:liquibase-core")
    developmentOnly("org.springframework.boot:spring-boot-devtools")
    runtimeOnly("org.postgresql:postgresql")

    // Redis
    implementation("io.lettuce:lettuce-core")

    // JWT Security
    implementation("org.springframework.security:spring-security-oauth2-resource-server")
    implementation("org.springframework.security:spring-security-oauth2-jose")
    implementation("com.nimbusds:nimbus-jose-jwt:10.0.2")

    // HTTP client
    implementation("com.fasterxml.jackson.module:jackson-module-jsonSchema")

    // OpenAPI
    implementation("org.springdoc:springdoc-openapi-starter-webflux-ui:2.7.0")

    // Swagger
    implementation("io.swagger.codegen.v3:swagger-codegen-generators:1.0.56") {
        exclude(group = "ch.qos.logback", module = "logback-classic")
        exclude(group = "ch.qos.logback", module = "logback-core")
    }

    // AI dependencies
    implementation(platform("dev.langchain4j:langchain4j-bom:1.9.1"))
    implementation("dev.langchain4j:langchain4j")
    implementation("dev.langchain4j:langchain4j-open-ai")
    implementation("dev.langchain4j:langchain4j-anthropic")
    implementation("dev.langchain4j:langchain4j-google-ai-gemini")
    implementation("dev.langchain4j:langchain4j-reactor")
    implementation("dev.langchain4j:langchain4j-spring-boot-starter")

    // Testing
    testImplementation("org.springframework.boot:spring-boot-starter-test")
    testImplementation("io.projectreactor:reactor-test")
    testImplementation("org.springframework.security:spring-security-test")
    testImplementation("org.jetbrains.kotlin:kotlin-test-junit")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")

    // Testcontainers
    testImplementation("org.testcontainers:testcontainers:1.19.0")
    testImplementation("org.testcontainers:junit-jupiter:1.19.0")
    testImplementation("org.testcontainers:postgresql:1.19.0")
    testImplementation("org.testcontainers:r2dbc:1.19.0")
}

tasks.test { useJUnitPlatform() }

tasks.bootJar { archiveFileName.set("${project.name}-${project.version}.jar") }

springBoot { buildInfo() }

java { toolchain { languageVersion.set(JavaLanguageVersion.of(21)) } }

tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile> {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_21)
        javaParameters.set(true)
    }
}

tasks.named("check") { dependsOn("spotlessCheck") }
