FROM node:24-bookworm-slim AS build

WORKDIR /app

RUN npm install --global pnpm@11.19.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/prime/package.json apps/prime/package.json
RUN pnpm install --frozen-lockfile

COPY apps/prime apps/prime
COPY migrations migrations
RUN pnpm --filter @gremlin/prime build

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

RUN npm install --global pnpm@11.19.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/prime/package.json apps/prime/package.json
RUN pnpm install --prod --frozen-lockfile

COPY --from=build /app/apps/prime/dist apps/prime/dist
COPY --from=build /app/migrations migrations

USER node
EXPOSE 3000

CMD ["node", "apps/prime/dist/main.js"]
