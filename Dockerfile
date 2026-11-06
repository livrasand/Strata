FROM node:22-alpine AS build
ENV NODE_ENV=production

WORKDIR /srv/app/

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

FROM node:22-alpine
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
EXPOSE 3000
WORKDIR /srv/app/

COPY --from=build /srv/app/ /srv/app/
COPY src /srv/app/src
COPY index.html /srv/app/

RUN [ "chown", "-R", "node:node", "/srv/app" ]
USER node

HEALTHCHECK --interval=1m --timeout=10s --start-period=10s --retries=3 \
  CMD wget -q -O- "http://127.0.0.1:${PORT}/health" || exit 1

CMD [ "npm", "run", "start" ]
