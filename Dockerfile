FROM node:22-bookworm-slim
# ffmpeg Debian : x264, vp9, svt-av1, opus inclus
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
COPY public ./public
COPY db ./db
COPY cli ./cli
COPY bridge ./bridge
USER node
CMD ["node", "src/api.js"]
