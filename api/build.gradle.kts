plugins {
    kotlin("jvm")
    kotlin("plugin.allopen")
    kotlin("plugin.serialization")
    kotlin("plugin.spring")
    kotlin("plugin.jpa")
    id("org.springframework.boot")
    id("io.spring.dependency-management")
}

dependencyManagement {
    imports {
        mavenBom("org.jetbrains.exposed:exposed-bom:1.0.0-rc-3")
        mavenBom("org.springframework.cloud:spring-cloud-dependencies:2024.0.0")
    }
}

allOpen {
    annotation("org.springframework.stereotype.Component")
    annotation("org.springframework.stereotype.Service")
    annotation("org.springframework.web.bind.annotation.RestController")
    annotation("org.springframework.data.relational.core.mapping.Table")
    annotation("org.springframework.boot.test.context.SpringBootTest")
}

dependencies {
    implementation(project(":core"))

    // Spring Boot starters specific to api
    implementation("org.springframework.boot:spring-boot-starter-webflux")
    implementation("org.springframework.boot:spring-boot-starter-rsocket")
    implementation("org.springframework.boot:spring-boot-starter-security")
    implementation("org.springframework.security:spring-security-rsocket")
    implementation("org.springframework.boot:spring-boot-starter-actuator")
    implementation("org.springframework.boot:spring-boot-starter-validation")
    implementation("org.springframework.cloud:spring-cloud-starter")
    implementation("org.springframework.cloud:spring-cloud-context")

    developmentOnly("org.springframework.boot:spring-boot-devtools")

    // JWT / OAuth
    implementation("org.springframework.security:spring-security-oauth2-resource-server")
    implementation("org.springframework.security:spring-security-oauth2-jose")
    implementation("com.nimbusds:nimbus-jose-jwt:10.0.2")

    // HTTP / JSON
    implementation("com.fasterxml.jackson.module:jackson-module-jsonSchema")

    // OpenAPI
    implementation("org.springdoc:springdoc-openapi-starter-webflux-ui:2.7.0")

    // Swagger codegen
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

    // Tests
    testImplementation("org.springframework.boot:spring-boot-starter-test")
    testImplementation("io.projectreactor:reactor-test")
    testImplementation("org.springframework.security:spring-security-test")
    testImplementation("org.jetbrains.kotlin:kotlin-test-junit")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation(testFixtures(project(":core")))
}

springBoot {
    mainClass.set("com.plugin.api.ApiApplicationKt")
    buildInfo()
}

java {
    toolchain { languageVersion.set(JavaLanguageVersion.of(21)) }
}

tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_21)
        javaParameters.set(true)
    }
}

tasks.withType<Test>().configureEach {
    useJUnitPlatform()
}
