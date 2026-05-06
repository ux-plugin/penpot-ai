from pydantic import BaseModel
from typing import List, Optional, Union


class ContentPart(BaseModel):
    text: Optional[str]
    type: str


class ImageContentPart(BaseModel):
    image_url: Optional[str]
    detail: Optional[str]
    type: str


class AudioContentPart(BaseModel):
    input_audio: Optional[str]
    format: str
    type: str


class FileContentPart(BaseModel):
    file_data: Optional[str]
    file_id: Optional[str]
    filename: Optional[str]
    type: str


class ToolCall(BaseModel):
    arguments: str
    name: str
    id: str
    type: str


class Message(BaseModel):
    role: str
    content: Optional[Union[str, List[ContentPart]]] = None
    text: Optional[str] = None
    type: Optional[str] = None
    name: Optional[str] = None
    audio: Optional[dict] = None
    tool_calls: Optional[List[ToolCall]] = None


class DeveloperMessage(Message):
    role: str = "developer"


class SystemMessage(Message):
    role: str = "system"


class UserMessage(Message):
    role: str = "user"


class AssistantMessage(Message):
    role: str = "assistant"


class FunctionMessage(BaseModel):
    content: Optional[str] = None
    name: str
    role: str = "function"


class ToolMessage(Message):
    tool_call_id: str


class RequestModel(BaseModel):
    messages: List[Message]
