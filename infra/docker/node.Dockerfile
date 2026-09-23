# Imagem de produção de um app do monorepo (api ou worker).
# Uso: docker build -f infra/docker/node.Dockerfile --target api --build-arg APP=api -t waychat-api .
#      docker build -f infra/docker/node.Dockerfile --target worker --build-arg APP=worker -t waychat-worker .
#
# Estágio 1 compila o monorepo; estágio 2 copia só o necessário (dependências de produção + dist)
# para uma imagem distroless: sem shell, sem gerenciador de pacotes, rodando como usuário não-root.
FROM node:25-slim AS build
ARG APP
RUN test -n "$APP" || (echo "defina --build-arg APP=api|worker" && exit 1)
RUN npm install -g pnpm@11.8.0
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter "@waychat/${APP}..." build
RUN pnpm --filter "@waychat/${APP}" deploy --legacy --prod /out

FROM gcr.io/distroless/nodejs24-debian13:nonroot AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out /app
USER nonroot

# Alvos finais: --target api (porta 3000, métricas 9464) ou --target worker (métricas 9465). Métricas ficam na rede interna.
FROM runtime AS api
EXPOSE 3000
CMD ["--import", "./dist/instrumentation.js", "./dist/server.js"]

FROM runtime AS worker
CMD ["--import", "./dist/instrumentation.js", "./dist/main.js"]
