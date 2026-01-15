FROM node:22-bookworm-slim

# Install system dependencies first so they are cached efficiently
RUN apt-get update && apt-get install -y python3 python3-pip python3-full ffmpeg curl build-essential python3-dev chromium && rm -rf /var/lib/apt/lists/*

# Install yt-dlp and dependencies
RUN pip install -U "yt-dlp[impersonate]" "curl_cffi" --break-system-packages

WORKDIR /app

COPY package.json pnpm-lock.yaml ./

RUN npm install -g corepack@latest
RUN corepack enable && corepack prepare pnpm@10 --activate
RUN pnpm install --frozen-lockfile

COPY src ./src

EXPOSE ${TELEGRAM_WEBHOOK_PORT}

CMD ["npm", "start"]
