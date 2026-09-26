# CandleOdds Auto worker. Built once per release tag by .github/workflows/release.yml.
FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .
USER node
CMD ["node", "start.mjs"]
