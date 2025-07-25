from pydantic import BaseModel, validator
from typing import Optional, List

# Valid GitHub API scopes
VALID_SCOPES = [
    "repo",
    "repo:status",
    "repo_deployment",
    "public_repo",
    "repo:invite",
    "security_events",
    "admin:repo_hook",
    "write:repo_hook",
    "read:repo_hook",
    "admin:org",
    "write:org",
    "read:org",
    "admin:public_key",
    "write:public_key",
    "read:public_key",
    "admin:org_hook",
    "gist",
    "notifications",
    "user",
    "read:user",
    "user:email",
    "user:follow",
    "project",
    "read:project",
    "delete_repo",
    "write:packages",
    "read:packages",
    "delete:packages",
    "admin:gpg_key",
    "write:gpg_key",
    "read:gpg_key",
    "codespace",
    "workflow",
    "read:audit_log"
]


class TokenExchangeRequest(BaseModel):
    client_id: str
    client_secret: str
    code: str
    redirect_uri: Optional[str] = None
    state: Optional[str] = None

    @validator('client_id', 'client_secret', 'code')
    def validate_required_fields(cls, v):
        if not v:
            raise ValueError("This field is required")
        return v


class GitHubOAuthTokenResponse(BaseModel):
    access_token: str = "ghu_exampleaccesstoken123"
    expires_in: int = 28800
    refresh_token: str = "ghr_examplerefreshtoken456"
    refresh_token_expires_in: int = 15897600
    scope: str = ""  # always an empty string
    token_type: str = "bearer"


class GitHubUser(BaseModel):
    id: int = 1
    login: str = "mock-github-user"
    avatar_url: str = "https://example.com/avatar.jpg"
    email: Optional[str] = "mock-user@example.com"
    name: Optional[str] = "Mock GitHub User"
    type: str = "User"
    site_admin: bool = False
    company: Optional[str] = "GitHub"
    blog: Optional[str] = "https://github.com/blog"
    location: Optional[str] = "San Francisco"
    hireable: Optional[bool] = False
    bio: Optional[str] = "There once was..."
    twitter_username: Optional[str] = "mockuser"
    public_repos: int = 2
    public_gists: int = 1
    followers: int = 20
    following: int = 0
    created_at: str = "2008-01-14T04:33:35Z"
    updated_at: str = "2008-01-14T04:33:35Z"
