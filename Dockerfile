FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build && npm prune --omit=dev

RUN mkdir -p /vault /data

EXPOSE 2768

ENV VAULT_PATH=/vault
ENV DATA_DIR=/data
ENV VAULT_API_PORT=2768
ENV VAULT_API_BIND=0.0.0.0
ENV VAULT_API_KEY=
ENV VAULT_API_ALLOWED_COMMANDS=*
ENV VAULT_API_AUTO_UPDATE=false

CMD ["node", "dist/index.js"]
