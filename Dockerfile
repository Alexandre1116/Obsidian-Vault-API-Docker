FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --production || npm install --production

COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

RUN mkdir -p /vault /data

EXPOSE 2768

ENV VAULT_PATH=/vault
ENV DATA_DIR=/data
ENV VAULT_API_PORT=2768
ENV VAULT_API_BIND=0.0.0.0
ENV VAULT_API_KEY=
ENV VAULT_API_ALLOWED_COMMANDS=*

CMD ["node", "dist/index.js"]
