# Gestor VPS: Node sin dependencias. Lee /proc del host y habla con Docker por su socket.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOST_PROC=/host/proc \
    DOCKER_SOCKET=/var/run/docker.sock

COPY package.json ./
COPY src ./src
COPY public ./public

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1

CMD ["node", "src/server.js"]
