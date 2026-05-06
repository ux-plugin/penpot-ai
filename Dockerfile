# Multi-stage build for one of the Spring Boot subprojects (api, anonymizer, processor).
# Pick the subproject with --build-arg MODULE=<api|anonymizer|processor>.

# Stage 1: build all jars
FROM gradle:8.10-jdk21 AS builder

ARG MODULE=api

WORKDIR /app

# Copy gradle wrapper + build files
COPY build.gradle.kts settings.gradle.kts gradle.properties ./
COPY gradle ./gradle
COPY gradlew gradlew.bat ./

# Copy each subproject's build script + sources. Done as separate COPYs so the
# build cache invalidates per subproject when only one changes.
COPY core ./core
COPY api ./api
COPY anonymizer ./anonymizer
COPY processor ./processor

# Build the requested subproject's bootJar (skip tests for faster image builds)
RUN ./gradlew :${MODULE}:bootJar -x test --no-daemon

# Stage 2: runtime image
FROM eclipse-temurin:21-jre-alpine

ARG MODULE=api

WORKDIR /app

# Copy the chosen subproject's bootJar
COPY --from=builder /app/${MODULE}/build/libs/${MODULE}-0.0.1.jar app.jar

# Expose port (only meaningful for api; workers ignore)
EXPOSE 8080

ENTRYPOINT ["java", "-jar", "app.jar"]
