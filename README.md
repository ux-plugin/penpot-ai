# Figma Plugin API

A reactive REST API built with Spring Boot 4, Kotlin, and coroutines for managing Figma plugin functionality.

## Technology Stack

- **Framework**: Spring Boot 4.3.1
- **Language**: Kotlin 2.1.20
- **Java**: 21
- **Database**: PostgreSQL with R2DBC (Reactive)
- **Cache**: Redis (Reactive)
- **Security**: Spring Security with JWT
- **API Documentation**: OpenAPI 3.0 / Swagger
- **Build Tool**: Gradle

## Architecture

This application uses a fully reactive architecture:

- **WebFlux**: Reactive web framework
- **R2DBC**: Non-blocking database access
- **Redis Reactive**: Non-blocking caching and pub/sub
- **Kotlin Coroutines**: Simplified asynchronous programming with suspend functions

## Features

- ✅ JWT-based authentication and authorization
- ✅ User management with CRUD operations
- ✅ Social login support (GitHub, Figma)
- ✅ Encryption key management
- ✅ Port state management with Redis pub/sub
- ✅ Reactive database access with PostgreSQL
- ✅ API documentation with Swagger UI

## Prerequisites

- Java 21 or higher
- PostgreSQL database
- Redis server
- Gradle (wrapper included)

## Configuration

Set the following environment variables:

### Database
- `DB_HOST` (default: localhost)
- `DB_PORT` (default: 5432)
- `DB_NAME` (default: figma_plugin)
- `DB_USERNAME` (default: postgres)
- `DB_PASSWORD` (default: password)

### Redis
- `REDIS_HOST` (default: localhost)
- `REDIS_PORT` (default: 6379)

### Server
- `API_PORT` (default: 8003)
- `API_HOST` (default: 0.0.0.0)

### API Keys
- `OPENAI_API_KEY`
- `OPENAI_PROJECT_ID`
- `OPENAI_ORG_ID`
- `FIREWORKS_API_KEY`

## Project layout

This repo is a multi-module Gradle build. Each subproject is an independently buildable, deployable artifact.

```
figma_plugin_api/
├── core/         # Shared library (no Spring Boot main). DB, Redis, ObjectStore, util.
├── api/          # Public HTTP + RSocket API (auth, completions, user, ingestion controllers).
├── anonymizer/   # Worker subproject — anonymizes ingested chunks (stub today).
└── processor/    # Worker subproject — processes anonymized chunks (stub today).
```

Subprojects depend only on `core` (no cross-dependencies between `api`, `anonymizer`, `processor`). Workers do not pull `webflux` / `spring-security`, keeping their images smaller.

## Building

```bash
# Build everything
./gradlew build

# Build a single subproject
./gradlew :api:build
./gradlew :anonymizer:build
./gradlew :processor:build

# Build the bootJar for one subproject (skip tests)
./gradlew :api:bootJar -x test
```

Each subproject produces its own bootJar in `<subproject>/build/libs/<subproject>-0.0.1.jar`.

## Running

```bash
# API (HTTP + RSocket)
./gradlew :api:bootRun

# Workers (no HTTP listener; consume Redis streams + S3 once Ticket 1 lands)
./gradlew :anonymizer:bootRun
./gradlew :processor:bootRun

# Run a built JAR directly
java -jar api/build/libs/api-0.0.1.jar
```

## Docker

Single Dockerfile parameterised by `MODULE` build-arg:

```bash
./gradlew :api:bootJar :anonymizer:bootJar :processor:bootJar
docker build --build-arg MODULE=api          -t figma-plugin-api:dev .
docker build --build-arg MODULE=anonymizer   -t figma-plugin-anonymizer:dev .
docker build --build-arg MODULE=processor    -t figma-plugin-processor:dev .
```

The compose `app` service builds with `MODULE=api`. Worker services can be added the same way when the worker logic ships.

## API Documentation

Once the application is running, access the API documentation at:

- **Swagger UI**: http://localhost:8003/swagger-ui.html
- **OpenAPI Spec**: http://localhost:8003/openapi

## Endpoints

### Authentication
- `POST /auth/access-token/refresh` - Refresh access token
- `GET /auth/refresh-token` - Get refresh token
- `GET /auth/plugin-ui/refresh-token` - Get refresh token for plugin UI
- `POST /auth/plugin-ui/access-token/refresh` - Refresh access token for plugin UI
- `DELETE /auth/socials/{id}/delete` - Delete social login

### User Management
- `GET /user/info` - Get user information
- `POST /user/update` - Update user information
- `DELETE /user/delete` - Delete user account
- `GET /user/socials` - Get social login profiles
- `POST /user/key` - Generate encryption key
- `GET /user/key` - Get encryption key
- `POST /user/port` - Update port state

## Development

### Code Style
The project uses Spotless for code formatting with ktfmt:

```bash
# Check code formatting
./gradlew spotlessCheck

# Apply code formatting
./gradlew spotlessApply
```

### Database Migrations
Database migrations are managed with Liquibase. Migrations run automatically on `api` startup. Workers set `spring.liquibase.enabled=false` and share the schema.

Migration files: `core/src/main/resources/db/changelog/`

### Source layout

```
core/src/main/kotlin/com/plugin/core/
├── util/                      # Shared utilities (logging extensions, ...)
└── ...                        # Object store, queue, ingestion domain land here

api/src/main/kotlin/com/plugin/api/
├── ApiApplication.kt          # @SpringBootApplication
├── config/                    # SecurityConfig, JwtDecoders, OpenApiConfig, R2dbcConfig, RedisConfig, ...
│   ├── ai/                    # AI model providers
│   └── properties/            # @ConfigurationProperties classes
├── dev/                       # Dev-only beans (HTTP exchanges endpoint, dev security, ...)
└── features/
    ├── auth/                  # auth0 / figma / github OAuth + core auth service
    ├── completions/           # AI completions over RSocket
    └── user/                  # User management

anonymizer/src/main/kotlin/com/plugin/anonymizer/
└── AnonymizerApplication.kt   # Stub Spring Boot app (worker logic lands in Ticket 3)

processor/src/main/kotlin/com/plugin/processor/
└── ProcessorApplication.kt    # Stub Spring Boot app (worker logic lands in Ticket 4)
```

## Migration from Quarkus

This application was recently migrated from Quarkus to Spring Boot 4. See [SPRING_BOOT_MIGRATION.md](SPRING_BOOT_MIGRATION.md) for detailed migration notes.

## Testing

```bash
# Run all tests
./gradlew test

# Run specific test
./gradlew test --tests "com.plugin.*"
```

## Docker Support

Docker Compose is configured for local development with PostgreSQL and Redis services.

### Setup

1. **Configure environment variables**:
   - Copy `.env.example` to `.env`
   - Fill in your actual API keys and credentials in `.env`

2. **Start services**:
   ```bash
   # Start all services (builds app on first run)
   docker-compose up -d
   
   # View logs
   docker-compose logs -f app
   
   # Stop services
   docker-compose down
   
   # Stop and remove volumes (resets database)
   docker-compose down -v
   ```

3. **Rebuild after code changes**:
   ```bash
   docker-compose up -d --build
   ```

### Database Reset

If you need to reset the database (e.g., after migration changes):

```bash
# Remove all containers and volumes
docker-compose down -v

# Start fresh
docker-compose up -d
```

This will:
- Delete the old database
- Create a new database
- Run all Liquibase migrations from scratch

### Services

The Docker Compose setup includes:

- **app**: Spring Boot application (port 8080)
- **postgres**: PostgreSQL 15 database (port 5432)
- **redis**: Redis 7 cache (port 6379)

### Environment Variables

Required environment variables in `.env`:
- `OPENAI_API_KEY`, `OPENAI_PROJECT_ID`, `OPENAI_ORG_ID`
- `FIREWORKS_API_KEY`
- `AUTH_FIGMA_CLIENT_ID`, `AUTH_FIGMA_CLIENT_SECRET`
- `AUTH_GITHUB_CLIENT_ID`, `AUTH_GITHUB_CLIENT_SECRET`

## License

Apache 2.0

## Support

For issues and questions, please contact: support@example.com
