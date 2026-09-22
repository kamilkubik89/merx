FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY examples ./examples
ENV PORT=3000
EXPOSE 3000
# Mount your catalog and key:  -v $PWD/catalog.json:/data/catalog.json -e MERX_CATALOG=/data/catalog.json
CMD ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "src/server.ts"]
