FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS dependencies
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/metadata/package.json packages/metadata/package.json
COPY packages/providers/package.json packages/providers/package.json
COPY packages/downloaders/package.json packages/downloaders/package.json
COPY packages/libraries/package.json packages/libraries/package.json
COPY packages/database/package.json packages/database/package.json
RUN pnpm install --frozen-lockfile=false

FROM dependencies AS build
COPY . .
RUN pnpm build

FROM node:24-alpine AS server
ENV NODE_ENV=production
WORKDIR /app
RUN mkdir -p /data/staging /data/libraries && chown -R node:node /data
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=dependencies /app/packages ./packages
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/metadata/dist ./packages/metadata/dist
COPY --from=build /app/packages/providers/dist ./packages/providers/dist
COPY --from=build /app/packages/downloaders/dist ./packages/downloaders/dist
COPY --from=build /app/packages/libraries/dist ./packages/libraries/dist
COPY --from=build /app/packages/database/migrations ./packages/database/migrations
COPY package.json pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/metadata/package.json packages/metadata/package.json
COPY packages/providers/package.json packages/providers/package.json
COPY packages/downloaders/package.json packages/downloaders/package.json
COPY packages/libraries/package.json packages/libraries/package.json
USER node
EXPOSE 3000
CMD ["node", "apps/server/dist/index.js"]

FROM nginx:1.29-alpine AS web
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
