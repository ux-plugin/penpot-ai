# Filename: main.py
import urllib.parse
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Header, Form
from fastapi.middleware.cors import CORSMiddleware
from pydantic.v1 import BaseSettings
from typing import Optional, Dict

from request import GitHubOAuthTokenResponse, GitHubUser

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
    GITHUB_MOCK_PORT: int = 5500
    GITHUB_CLIENT_ID: str = "test"
    GITHUB_CLIENT_SECRET: str = "test"


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


def validate_client_credentials(client_id: str, client_secret: str) -> bool:
    """Validate client credentials."""
    return (client_id == SETTINGS.GITHUB_CLIENT_ID and
            client_secret == SETTINGS.GITHUB_CLIENT_SECRET)


# Mock endpoint for exchanging authorization code for token
@app.post("/login/oauth/access_token")
async def exchange_token(
        accept: Optional[str] = Header(None),
        client_id: str = Form(...),
        client_secret: str = Form(...),
        code: str = Form(...),
        redirect_uri: str = Form(None)
):
    print("Received token exchange request", flush=True)

    # Validate required fields
    if not client_id or not client_secret or not code:
        raise HTTPException(status_code=400, detail="Missing required fields")

    # Validate client credentials
    if not validate_client_credentials(client_id, client_secret):
        raise HTTPException(status_code=401, detail="Invalid client credentials")

    # Return successful response
    return GitHubOAuthTokenResponse()


# Mock endpoint for getting user information
@app.get("/user")
async def get_user(authorization: Optional[str] = Header(None)):
    if not authorization:
        raise HTTPException(status_code=401, detail="Authorization header is required")

    # Check if the authorization header starts with "Bearer "
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Invalid authorization format")

    try:
        # In a real implementation, we would validate the token
        # but for the mock we just return a successful response
        return GitHubUser()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")


if __name__ == "__main__":
    uvicorn.run(app="main:app", port=SETTINGS.GITHUB_MOCK_PORT, host="0.0.0.0")
