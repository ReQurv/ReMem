# ReMem MCP server (enterprise HTTP, multi-tenant)
#
#   docker build -t requrv/remem-mcp .
#   docker run --env-file .env -p 3100:3100 requrv/remem-mcp
#
# Requires: Bun (Elysia). The stdio server (remem-mcp) is NOT the default
# entrypoint — it is meant to be spawned by agents, not containerized.

FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER bun
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD bun -e "fetch('http://localhost:3100/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["bun", "dist/remem-mcp-http.js"]
