# Figma Mock Server

This is a mock server for the Figma API endpoints used by the FigmaRestClient in the application.

## Endpoints

The server mocks the following endpoints:

1. `POST /v1/oauth/token` - For exchanging authorization code for token and refreshing tokens
2. `GET /v1/me` - For getting user information

## Authentication

The server validates Basic Authentication for the token exchange endpoint. The format should be:

```
Authorization: Basic <BASE64_ENCODED_CLIENT_ID_AND_SECRET>
```

Where `<BASE64_ENCODED_CLIENT_ID_AND_SECRET>` is the Base64 encoding of `client_id:client_secret`.

## Scope Validation

The server validates that the requested scope is one of the following valid Figma API scopes:

- current_user:read
- file_comments:read
- file_comments:write
- file_content:read
- file_dev_resources:read
- file_dev_resources:write
- file_metadata:read
- file_variables:read
- file_variables:write
- file_versions:read
- files:read
- library_analytics:read
- library_assets:read
- library_content:read
- org:activity_log_read
- org:discovery_read
- projects:read
- team_library_content:read
- webhooks:read
- webhooks:write

## Usage

The server can be run using Docker:

```bash
docker build -t figma-mock .
docker run -p 5500:5500 -e FIGMA_CLIENT_ID=your_client_id -e FIGMA_CLIENT_SECRET=your_client_secret figma-mock
```

Or directly with Python:

```bash
export FIGMA_CLIENT_ID=your_client_id
export FIGMA_CLIENT_SECRET=your_client_secret
uv sync
uv run main.py
```

## Configuration

The following environment variables can be configured:

- `FIGMA_MOCK_PORT` - The port on which the server will listen (default: 5500)
- `FIGMA_CLIENT_ID` - The client ID for Basic Authentication (default: default_client_id)
- `FIGMA_CLIENT_SECRET` - The client secret for Basic Authentication (default: default_client_secret)
