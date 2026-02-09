FROM node:22-bookworm-slim

# Install system dependencies first so they are cached efficiently
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    python3-dev \
    ffmpeg \
    curl \
    build-essential \
  && rm -rf /var/lib/apt/lists/*

# Install yt-dlp nightly and pin a curl_cffi version supported by yt-dlp impersonation
RUN pip install -U --pre "yt-dlp[impersonate]" "curl_cffi==0.11.4" --break-system-packages

# Install Rust bgutil PO token provider plugin for yt-dlp
RUN rm -rf /usr/local/lib/python3.11/dist-packages/yt_dlp_plugins \
  && curl -fsSL "https://github.com/jim60105/bgutil-ytdlp-pot-provider-rs/releases/latest/download/bgutil-ytdlp-pot-provider-rs.zip" -o /tmp/bgutil-ytdlp-pot-provider-rs.zip \
  && python3 -c "import zipfile; zipfile.ZipFile('/tmp/bgutil-ytdlp-pot-provider-rs.zip').extractall('/usr/local/lib/python3.11/dist-packages')" \
  && rm -f /tmp/bgutil-ytdlp-pot-provider-rs.zip

WORKDIR /app

COPY package.json pnpm-lock.yaml ./

RUN npm install -g corepack@latest
RUN corepack enable && corepack prepare pnpm@10 --activate
RUN pnpm install --frozen-lockfile

COPY src ./src
COPY vendor ./vendor

EXPOSE ${TELEGRAM_WEBHOOK_PORT}

CMD ["npm", "start"]
