FROM node:22-alpine
LABEL org.opencontainers.image.source="https://github.com/kamilkubik89/merx" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.description="Merx — open-source commerce engine for AI agents"
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY examples ./examples
ENV PORT=3000
EXPOSE 3000
# Mount your catalog and key:  -v $PWD/catalog.json:/data/catalog.json -e MERX_CATALOG=/data/catalog.json
# Durable state:               -v merx-data:/data -e MERX_STORE=sqlite:/data/merx.db
# Payment providers are opt-in through environment variables; see .env.example.
CMD ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "src/server.ts"]
