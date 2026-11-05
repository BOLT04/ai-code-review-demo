FROM node:24-bookworm-slim

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY api.js server.js ./
USER node
ENV NODE_ENV=production
EXPOSE 3010
CMD ["node", "server.js"]
