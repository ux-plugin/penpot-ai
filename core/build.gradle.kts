plugins {
    kotlin("jvm")
    kotlin("plugin.allopen")
    kotlin("plugin.serialization")
    kotlin("plugin.spring")
    kotlin("plugin.jpa")
    id("io.spring.dependency-management")
    `java-library`
    `java-test-fixtures`
}

dependencyManagement {
    imports {
        mavenBom("org.springframework.boot:spring-boot-dependencies:3.4.12")
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
    // Kotlin support
    api("org.jetbrains.kotlin:kotlin-stdlib-jdk8")
    api("org.jetbrains.kotlin:kotlin-reflect")
    api("com.fasterxml.jackson.module:jackson-module-kotlin")
    api("io.projectreactor.kotlin:reactor-kotlin-extensions")

    // Coroutines
    api("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.10.2")
    api("org.jetbrains.kotlinx:kotlinx-coroutines-reactor:1.10.2")
    api("org.jetbrains.kotlinx:kotlinx-serialization-json:1.8.1")

    // Spring Boot data layer (shared by api + workers)
    api("org.springframework.boot:spring-boot-starter-data-r2dbc")
    api("org.springframework.boot:spring-boot-starter-data-redis-reactive")

    // Exposed (BOM not propagated to consumers, so pin versions explicitly here)
    api(platform("org.jetbrains.exposed:exposed-bom:1.0.0-rc-3"))
    api("org.jetbrains.exposed:exposed-core")
    api("org.jetbrains.exposed:exposed-r2dbc")
    api("org.jetbrains.exposed:exposed-dao")
    api("org.jetbrains.exposed:exposed-java-time")

    // Database drivers + migrations
    api("org.postgresql:r2dbc-postgresql:1.0.7.RELEASE")
    api("org.liquibase:liquibase-core")
    runtimeOnly("org.postgresql:postgresql")

    // Redis
    api("io.lettuce:lettuce-core")

    // Object store (used by ingestion + workers; lands in core in Ticket 1)
    api("software.amazon.awssdk:s3:2.28.16")
    api("software.amazon.awssdk:netty-nio-client:2.28.16")
    api("org.jetbrains.kotlinx:kotlinx-coroutines-jdk8:1.10.2")

    // Test fixtures (shared Testcontainers infra exposed to subprojects)
    testFixturesApi("org.springframework.boot:spring-boot-starter-test")
    testFixturesApi("io.projectreactor:reactor-test")
    testFixturesApi("org.jetbrains.kotlin:kotlin-test-junit")
    testFixturesApi("org.testcontainers:testcontainers:1.19.0")
    testFixturesApi("org.testcontainers:junit-jupiter:1.19.0")
    testFixturesApi("org.testcontainers:postgresql:1.19.0")
    testFixturesApi("org.testcontainers:r2dbc:1.19.0")

    testImplementation("org.springframework.boot:spring-boot-starter-test")
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
