FROM node:24.21.0-trixie-slim AS dependencies
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# Keep package managers and shells out of the production image.
# Re-scan and update this digest when adopting a new runtime release.
FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:bb6b03d81066993293a10feda7250e8e1cc034035fe9b61cfceededa7c8bf04d
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./package.json
COPY src ./src
COPY public ./public
COPY views ./views
USER 65532:65532
RUN ["/nodejs/bin/node", "-e", "const assert=require('node:assert/strict'); const fs=require('node:fs'); assert.equal(process.versions.node.split('.')[0],'24'); assert.ok(Number(process.versions.node.split('.')[1])>=21); assert.equal(process.getuid(),65532); for(const p of ['/bin/sh','/usr/local/bin/npm','/usr/local/bin/yarn']) assert.ok(!fs.existsSync(p)); for(const p of ['express','express-rate-limit','pg','dotenv']) require(p); console.log(JSON.stringify({node:process.version,openssl:process.versions.openssl,uid:process.getuid(),runtimeCheck:'passed'}));"]
CMD ["src/server.js"]
