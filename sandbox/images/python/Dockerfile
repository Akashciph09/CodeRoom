# Runner image for untrusted Python submissions. Keep it minimal: no compilers, no network tools.
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /sandbox
USER 65534:65534
