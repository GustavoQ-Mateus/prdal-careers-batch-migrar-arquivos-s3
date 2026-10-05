FROM node:22-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

FROM base AS deps
WORKDIR /repo/apps/jobs/migrar-arquivos-s3
COPY apps/api/prisma/schema.prisma /repo/apps/api/prisma/schema.prisma
COPY apps/jobs/migrar-arquivos-s3/package.json apps/jobs/migrar-arquivos-s3/package-lock.json ./
COPY apps/jobs/migrar-arquivos-s3/scripts ./scripts
RUN npm ci --omit=dev
RUN npm prune --omit=dev --omit=optional --ignore-scripts

FROM base AS build
WORKDIR /repo/apps/jobs/migrar-arquivos-s3
COPY apps/api/prisma/schema.prisma /repo/apps/api/prisma/schema.prisma
COPY apps/jobs/migrar-arquivos-s3/package.json apps/jobs/migrar-arquivos-s3/package-lock.json ./
COPY apps/jobs/migrar-arquivos-s3/scripts ./scripts
RUN npm ci
COPY apps/jobs/migrar-arquivos-s3/tsconfig.json ./
COPY apps/jobs/migrar-arquivos-s3/src ./src
RUN npm run build

FROM base
WORKDIR /app
ENV NODE_ENV=production
RUN chown node:node /app
COPY --from=deps /repo/apps/jobs/migrar-arquivos-s3/node_modules ./node_modules
COPY --from=build /repo/apps/jobs/migrar-arquivos-s3/dist ./dist
USER node
CMD ["node", "dist/main.js"]
