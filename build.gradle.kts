val kotlinVersion: String by project
val quarkusPlatformGroupId: String by project
val quarkusPlatformArtifactId: String by project
val quarkusPlatformVersion: String by project
val swaggerCodegenVersion: String by project

plugins {
    kotlin("jvm") version "2.1.10"
    kotlin("plugin.allopen") version "2.1.10"
    id("io.quarkus")
}

repositories {
    mavenCentral()
    mavenLocal()
}

group = "com.plugin"
version = "0.0.1"

allOpen {
    annotation("jakarta.ws.rs.Path")
    annotation("jakarta.enterprise.context.ApplicationScoped")
    annotation("jakarta.persistence.Entity")
    annotation("io.quarkus.test.junit.QuarkusTest")
}

tasks.withType<Test> {
    systemProperty("java.util.logging.manager", "org.jboss.logmanager.LogManager")
}

dependencies {
    implementation("io.quarkus:quarkus-container-image-docker")
    implementation(enforcedPlatform("${quarkusPlatformGroupId}:quarkus-amazon-services-bom:${quarkusPlatformVersion}"))
    implementation(enforcedPlatform("${quarkusPlatformGroupId}:${quarkusPlatformArtifactId}:${quarkusPlatformVersion}"))

    implementation("io.quarkus:quarkus-kotlin")
    implementation("org.jetbrains.kotlin:kotlin-stdlib-jdk8")
    implementation("io.quarkus:quarkus-rest-jackson")


    implementation("io.quarkus:quarkus-config-yaml")
    implementation("io.quarkus:quarkus-smallrye-openapi")
    implementation("io.quarkus:quarkus-smallrye-context-propagation")
    implementation("io.quarkus:quarkus-arc")

    // HTTP client
    implementation("io.quarkus:quarkus-rest-client-jackson")
    implementation("io.quarkus:quarkus-jackson")
    implementation("com.fasterxml.jackson.module:jackson-module-kotlin")
    implementation("com.fasterxml.jackson.module:jackson-module-jsonSchema")

    // Logging
    implementation("io.quarkus:quarkus-logging-json")

    // Swagger
    implementation("io.swagger.codegen.v3:swagger-codegen-generators:$swaggerCodegenVersion")

    // Kotlin coroutines support
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.7.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-reactive:1.7.3")

    // Database dependencies
    implementation("io.quarkus:quarkus-hibernate-reactive-panache-kotlin")
    implementation("io.quarkus:quarkus-reactive-pg-client")
    implementation("io.quarkus:quarkus-liquibase")
    runtimeOnly("io.quarkus:quarkus-jdbc-postgresql")

    // AI dependencies
    implementation("com.openai:openai-java:2.2.1")
    implementation("dev.langchain4j:langchain4j:1.1.0")
    implementation("dev.langchain4j:langchain4j-open-ai:1.1.0")

    // Security
    implementation("io.quarkus:quarkus-security-jpa-reactive")
    implementation("io.quarkus:quarkus-smallrye-jwt")

    // Redis
    implementation("io.quarkus:quarkus-redis-client")

    // Testing
    testImplementation("io.quarkus:quarkus-junit5")
    testImplementation("io.rest-assured:rest-assured")
    testImplementation("org.jetbrains.kotlin:kotlin-test-junit:$kotlinVersion")
    testImplementation("io.quarkus:quarkus-test-security-jwt")

    // Pact for consumer-driven contract testing
    testImplementation("au.com.dius.pact.consumer:junit5:4.6.2")

    // Testcontainers for integration testing
    testImplementation("org.testcontainers:testcontainers:1.19.0")
    testImplementation("org.testcontainers:junit-jupiter:1.19.0")
    testImplementation("org.testcontainers:postgresql:1.19.0")


    // JUnit 5 dependencies
    testImplementation("org.junit.jupiter:junit-jupiter-api:5.10.0")
    testRuntimeOnly("org.junit.jupiter:junit-jupiter-engine:5.10.0")

    // Mockk for mocking in tests
    testImplementation("io.mockk:mockk:1.13.8")
}

tasks.test {
    useJUnitPlatform()
    systemProperty("pact_do_not_track", "true")
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_21
        javaParameters = true
    }
}
