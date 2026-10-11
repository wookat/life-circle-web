# 15 分钟生活圈 · 智能体检与规划助手 —— 一键构建镜像
# 构建: docker build -t life-circle-web .
# 运行: docker run --rm -p 8787:8787 life-circle-web            # 无 AK 演示模式（合成数据全链路）
#       docker run --rm -p 8787:8787 --env-file .env life-circle-web  # 真实 AK 通道

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8787
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
EXPOSE 8787
# --env-file-if-exists：有 .env 挂载则读取，无则以演示模式运行
CMD ["node", "--env-file-if-exists=.env", "dist-server/index.cjs"]
