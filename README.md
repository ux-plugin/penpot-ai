# Figma Plugin API

A reactive REST API built with Spring Boot 4, Kotlin, and coroutines for managing Figma plugin functionality.

## Technology Stack

- **Framework**: Spring Boot 4.3.1
- **Language**: Kotlin 2.2.10
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

## Building

```bash
# Build the application
./gradlew clean build

# Build without tests
./gradlew clean build -x test

# Create executable JAR
./gradlew bootJar
```

## Running

```bash
# Run with Gradle
./gradlew bootRun

# Run JAR directly
java -jar build/libs/figma_plugin_api-0.0.1.jar
```

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
Database migrations are managed with Liquibase. Migrations run automatically on startup.

Migration files: `src/main/resources/db/changelog/`

### Project Structure

```
src/main/kotlin/com/plugin/
├── config/                    # Configuration classes
│   ├── SecurityConfig.kt     # Security and JWT configuration
│   ├── JwtService.kt         # JWT token generation
│   ├── OpenApiConfig.kt      # OpenAPI/Swagger configuration
│   ├── WebConfig.kt          # CORS and web configuration
│   └── RedisConfig.kt        # Redis configuration
├── features/
│   ├── auth/core/            # Authentication and authorization
│   │   ├── Entity.kt         # Auth entities
│   │   ├── AuthRepository.kt # Auth data access
│   │   ├── AuthService.kt    # Auth business logic
│   │   ├── AuthResource.kt   # Auth REST endpoints
│   │   └── RedisRepository.kt # Redis operations
│   └── user/                 # User management
│       ├── Entity.kt         # User entities
│       ├── UserRepository.kt # User data access
│       └── UserService.kt    # User business logic and REST endpoints
└── FigmaPluginApplication.kt # Main application class
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
