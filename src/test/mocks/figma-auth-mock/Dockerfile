# Use the official Python image as a base
FROM python:3.13-slim

# Install uv (modern Python packaging tool)
RUN pip install --no-cache-dir uv

# Set workdir
WORKDIR /app

# Copy your application into the container
COPY main.py /app/
COPY pyproject.toml /app/
COPY request.py /app/

# Install application dependencies using uv
RUN uv sync

# Expose port (can be overridden, see CMD)
EXPOSE 5500

# Launch the FastAPI app via uvicorn. Use the env vars, which you can override with Testcontainers.
CMD ["uv", "run", "main.py"]
