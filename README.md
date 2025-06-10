# Figma Plugin API

A Kotlin/Quarkus based backend service for the Figma Plugin.

## Prerequisites

- Java 21 or later
- Docker and Docker Compose
- Gradle

## Getting Started

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd figma_plugin_api
   ```

2. **Copy the example environment file**
   ```bash
   cp .env.example .env
   ```
   Update the `.env` file with your configuration.

3. **Build the application**
   ```bash
   ./gradlew build
   ```

## Running with Docker Compose

To start the application and its dependencies (PostgreSQL) using Docker Compose:

```bash
docker-compose up --build
```

The application will be available at `http://localhost:8080`

## Development

### Running tests

```bash
./gradlew test
```

### Running the application locally

```bash
./gradlew quarkusDev
```

## API Documentation

When the application is running, you can access:

- Swagger UI: http://localhost:8080/q/swagger-ui/
- OpenAPI Schema: http://localhost:8080/q/openapi

## Database Migrations

The application uses Liquibase for database migrations. Migrations are automatically applied on application startup.

## License

[Your License Here]
