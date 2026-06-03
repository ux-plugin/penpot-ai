from pydantic import BaseModel, validator
from typing import Optional, List

# Valid Figma API scopes
VALID_SCOPES = [
    "current_user:read",
    "file_comments:read",
    "file_comments:write",
    "file_content:read",
    "file_dev_resources:read",
    "file_dev_resources:write",
    "file_metadata:read",
    "file_variables:read",
    "file_variables:write",
    "file_versions:read",
    "files:read",
    "library_analytics:read",
    "library_assets:read",
    "library_content:read",
    "org:activity_log_read",
    "org:discovery_read",
    "projects:read",
    "team_library_content:read",
    "webhooks:read",
    "webhooks:write"
]


class TokenExchangeRequest(BaseModel):
    code: str
    redirect_uri: str
    grant_type: str = "authorization_code"
    scope: Optional[str] = None

    @validator('scope')
    def validate_scope(cls, v):
        if v is None:
            return v

        scopes = v.split(',')
        for scope in scopes:
            if scope not in VALID_SCOPES:
                raise ValueError(f"Invalid scope: {scope}. Must be one of {VALID_SCOPES}")
        return v


class TokenRefreshRequest(BaseModel):
    refresh_token: str
    grant_type: str = "refresh_token"


# These models represent the response structures
class FigmaOAuthTokenResponse(BaseModel):
    user_id_string: Optional[str] = None
    user_id: int = 12345
    access_token: str = "mock-access-token"
    token_type: str = "bearer"
    expires_in: int = 3600
    refresh_token: str = "mock-refresh-token"


class FigmaRefreshTokenResponse(BaseModel):
    access_token: str = "mock-refreshed-access-token"
    token_type: str = "bearer"
    expires_in: int = 3600


class FigmaUser(BaseModel):
    id: str = "mock-user-id"
    handle: str = "mock-user"
    img_url: str = "https://example.com/profile.jpg"
    email: str = "mock-user@example.com"
