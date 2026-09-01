FROM node:24-bookworm-slim AS build

WORKDIR /app

RUN npm install --global pnpm@11.19.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/chat/package.json apps/chat/package.json
RUN pnpm install --frozen-lockfile

COPY apps/chat apps/chat
RUN pnpm --filter @gremlin/chat build

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

RUN npm install --global pnpm@11.19.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/chat/package.json apps/chat/package.json
RUN pnpm install --prod --frozen-lockfile

COPY --from=build /app/apps/chat/dist apps/chat/dist
COPY --from=build /app/apps/chat/public apps/chat/public

USER node
EXPOSE 3001

CMD ["node", "apps/chat/dist/main.js"]
