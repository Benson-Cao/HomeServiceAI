# 多阶段：builder 装 devDependencies 并编译；runtime 只带 build/ 产物 + 可选 pg 驱动。
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV MH_IN_CONTAINER=1
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/build ./build
COPY --from=builder /app/seams ./seams
COPY --from=builder /app/ci ./ci
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/examples ./examples
COPY --from=builder /app/config ./config
COPY --from=builder /app/docs ./docs
COPY --from=builder /app/README.md /app/CONTRACTS.md ./

# ③ 默认常驻 REST 服务；维护用一次性 CLI 时由 compose run 覆盖 command。
CMD ["node", "examples/daemon.mjs"]
