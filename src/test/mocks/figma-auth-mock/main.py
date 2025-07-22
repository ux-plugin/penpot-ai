# Filename: main.py
import base64
import os
import urllib.parse
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Header, Form
from fastapi.middleware.cors import CORSMiddleware
from pydantic.v1 import BaseSettings
from typing import Optional, Dict

from request import FigmaOAuthTokenResponse, FigmaRefreshTokenResponse, FigmaUser, VALID_SCOPES

load_dotenv()
app = FastAPI()

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class Settings(BaseSettings):
    FIGMA_MOCK_PORT: int = 5500
    FIGMA_CLIENT_ID: str = "test"
    FIGMA_CLIENT_SECRET: str = "test"


SETTINGS = Settings()


def parse_form_data(form_data: str) -> Dict[str, str]:
    """Parse form data string into a dictionary."""
    if not form_data:
        return {}

    result = {}
    pairs = form_data.split('&')
    for pair in pairs:
        if '=' in pair:
            key, value = pair.split('=', 1)
            result[urllib.parse.unquote(key)] = urllib.parse.unquote(value)

    return result


def validate_basic_auth(auth_header: str) -> bool:
    """Validate Basic Authentication header."""
    if not auth_header or not auth_header.startswith("Basic "):
        print(f"Invalid authorization header format. Expected it to start with Basic while it is {auth_header}",
              flush=True)
        return False

    try:
        # Extract the base64 encoded credentials
        encoded_credentials = auth_header.split(" ")[1]
        # Decode the credentials
        decoded_credentials = base64.b64decode(encoded_credentials).decode("utf-8")
        # Split into client_id and client_secret
        client_id, client_secret = decoded_credentials.split(":", 1)

        # Validate against environment variables
        print(
            f"validating {client_id}, {client_secret} with {SETTINGS.FIGMA_CLIENT_ID}, {SETTINGS.FIGMA_CLIENT_SECRET}")
        return (client_id == SETTINGS.FIGMA_CLIENT_ID and
                client_secret == SETTINGS.FIGMA_CLIENT_SECRET)
    except Exception as e:
        print(f"Error validating auth: {str(e)}")
        return False


# Mock endpoint for exchanging authorization code for token
@app.post("/v1/oauth/token")
async def exchange_token(
        authorization: Optional[str] = Header(None),
        form_data: str = None,
        refresh_token: Optional[str] = Form(None),
        grant_type: Optional[str] = Form(None)
):
    print("received a request")
    # Check if this is a token refresh request
    if refresh_token and grant_type == "refresh_token":
        return FigmaRefreshTokenResponse()

    # Otherwise, it's a token exchange request
    if not authorization:
        raise HTTPException(status_code=401, detail="Authorization header is required")

    # Validate Basic Authentication
    if not validate_basic_auth(authorization):
        raise HTTPException(
            status_code=401,
            detail="Invalid authorization. Format should be: Authorization: Basic <BASE64_ENCODED_CLIENT_ID_AND_SECRET>"
        )

    try:
        # Parse form data to validate scope
        parsed_data = parse_form_data(form_data)

        # Check if scope is provided and validate it
        if 'scope' in parsed_data:
            scopes = parsed_data['scope'].split(',')
            for scope in scopes:
                if scope not in VALID_SCOPES:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Invalid scope: {scope}. Must be one of {VALID_SCOPES}"
                    )

        # Return successful response
        return FigmaOAuthTokenResponse()
    except HTTPException as e:
        # Re-raise HTTP exceptions
        raise e
    except Exception as e:
        # Log and convert other exceptions to 500 errors
        print(f"Error processing request: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")


# Mock endpoint for getting user information
@app.get("/v1/me")
async def get_me(authorization: Optional[str] = Header(None)):
    if not authorization:
        raise HTTPException(status_code=401, detail="Authorization header is required")

    # Check if the authorization header starts with "Bearer "
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Invalid authorization format")

    try:
        # In a real implementation, we would validate the token
        # but for the mock we just return a successful response
        return FigmaUser()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")


if __name__ == "__main__":
    uvicorn.run(app="main:app", port=SETTINGS.FIGMA_MOCK_PORT, host="0.0.0.0")
