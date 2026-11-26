# syntax=docker/dockerfile:1.7
FROM node:22-alpine
RUN apk add --no-cache ca-certificates
RUN corepack enable && corepack prepare pnpm@10 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
# pnpm-lock 用 file:vendor/...tgz 引用本地 vendored 包,install 前必须就位(否则 frozen-lockfile 解析 file: 失败 exit 254)
COPY vendor vendor
RUN --mount=type=secret,id=github_token \
  GITHUB_TOKEN="$(cat /run/secrets/github_token)" pnpm install --frozen-lockfile --prod=false
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN cd apps/api && npx prisma generate
RUN pnpm --filter @ruidong/shared build
RUN pnpm --filter @ruidong/api build
RUN chown -R node:node /app
USER node
WORKDIR /app/apps/api
EXPOSE 3010
CMD ["node", "dist/billing-main.js"]
