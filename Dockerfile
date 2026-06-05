# syntax=docker/dockerfile:1

FROM node:26-slim

WORKDIR /app

ENV CI=1 \
    NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY package.json package-lock.json ./

EXPOSE 3000

CMD ["npm", "start"]
