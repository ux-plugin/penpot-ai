FROM python:3.11-slim

WORKDIR /app

COPY pyproject.toml .
COPY main.py .
COPY request.py .

RUN pip install --no-cache-dir -e .

EXPOSE 5500

CMD ["python", "main.py"]