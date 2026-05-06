# Filename: app.py
import json
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi import HTTPException
from pydantic.v1 import BaseSettings

from request import RequestModel

load_dotenv()
app = FastAPI()


class settings(BaseSettings):
    OPENAI_MOCK_PORT: int = 5400


with open("component.json", "r") as f:
    component_json = json.loads(f.read())

SETTINGS = settings()


@app.post("/chat/completions")
def completion(body: RequestModel):
    prompt = body.messages[0].content
    print(prompt)
    if "401" in prompt:
        raise HTTPException(
            status_code=401,
            detail="Unauthorized access. Cause: Invalid authentication. Ensure the correct API key and organization are being used."
        )
    elif "403" in prompt:
        raise HTTPException(
            status_code=403,
            detail="Access forbidden. Cause: Country, region, or territory not supported. Ensure you're accessing the API from a supported location."
        )
    elif "429" in prompt:
        raise HTTPException(
            status_code=429,
            detail="Rate limit exceeded. Cause: Too many requests or exceeded quota. Pace your requests or check your plan and billing details."
        )
    elif "500" in prompt:
        raise HTTPException(
            status_code=500,
            detail="Internal server error. Cause: Issue on our servers. Retry your request after a brief wait and contact support if the issue persists."
        )
    elif "503" in prompt:
        raise HTTPException(
            status_code=503,
            detail="Service unavailable. Cause: Server overloaded or high traffic. Retry your request after a brief wait or reduce your request rate."
        )
    return {
        "id": "chatcmpl-B9MBs8CjcvOU2jLn4n570S5qMJKcT",
        "object": "chat.completion",
        "created": 1741569952,
        "model": "gpt-4.1-2025-04-14",
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": f"{json.dumps(component_json)}",
                    "refusal": None,
                    "annotations": []
                },
                "logprobs": None,
                "finish_reason": "stop"
            }
        ],
        "usage": {
            "prompt_tokens": 19,
            "completion_tokens": 10,
            "total_tokens": 29,
            "prompt_tokens_details": {
                "cached_tokens": 0,
                "audio_tokens": 0
            },
            "completion_tokens_details": {
                "reasoning_tokens": 0,
                "audio_tokens": 0,
                "accepted_prediction_tokens": 0,
                "rejected_prediction_tokens": 0
            }
        },
        "service_tier": "default"
    }


if __name__ == "__main__":
    uvicorn.run(app="main:app", port=SETTINGS.OPENAI_MOCK_PORT, host="0.0.0.0")
