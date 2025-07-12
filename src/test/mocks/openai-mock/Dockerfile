# Use the official Python image as a base
FROM python:3.13-slim

# Install uv (modern Python packaging tool)
RUN pip install --no-cache-dir uv

# Set workdir
WORKDIR /app

# Copy your application into the container
COPY component.json /app/
COPY main.py /app/
COPY pyproject.toml /app/
COPY request.py /app/

# Install application dependencies using uv
RUN uv sync

# Expose port (can be overridden, see CMD)
EXPOSE 5000

# Default environment variable for port (can be overridden at runtime)
ENV OPENAI_MOCK_PORT=5000

# Launch the FastAPI app via uvicorn. Use the env var OPENAI_MOCK_PORT, which you can override with Testcontainers.
CMD ["uv", "run", "main.py"]