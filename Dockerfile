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
ENV VAULT_API_MANAGEMENT_AUTH=true

# Keep the V8 heap inside the memory limit of a small container so an oversized
# read becomes a catchable error instead of a cgroup OOM kill. With the 512 MB
# compose limit, 384 MB leaves room for sharp and the NFS page cache.
ENV NODE_OPTIONS=--max-old-space-size=384

# No curl in node:20-slim, so probe with node itself. Without this Docker cannot
# see a hung server and restart policies never fire.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const p=process.env.VAULT_API_PORT||'2768';fetch('http://127.0.0.1:'+p+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
