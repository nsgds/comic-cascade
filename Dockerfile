# Comic Cascade — a minimal, self-hostable comic reader.
# Single-stage image: the frontend is plain ES modules (no build step), served
# statically by the FastAPI backend. `unar` (The Unarchiver) is bundled to extract
# CBR (RAR) and 7z-disguised CBZ archives; it is called as a separate subprocess,
# so its LGPL/GPL licensing does not affect this project's 0BSD license.
FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends unar \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY web ./web

# Drop to an unprivileged user. Pre-create /cache so a fresh named volume mounted
# there inherits writable ownership. (For a bind-mounted cache, chown it on the host
# or override `user:` to match — see the deployment notes in the README.)
RUN useradd -u 1000 -m cascade \
    && mkdir -p /cache \
    && chown -R cascade:cascade /app /cache
USER cascade

EXPOSE 8080
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
