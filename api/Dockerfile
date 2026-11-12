FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY src ./src
COPY scripts ./scripts
COPY db ./db
COPY seed.json ./seed.json
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
