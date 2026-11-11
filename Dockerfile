# Hugging Face Spaces (Docker SDK) — serves the API *and* the website on port 7860
FROM python:3.11-slim
WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY pipeline pipeline
COPY backend backend
COPY site site
EXPOSE 7860
CMD ["uvicorn", "backend.app:app", "--host", "0.0.0.0", "--port", "7860"]
