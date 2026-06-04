# どのクラウドでも動くようにコンテナ化（Cloud Run / Render など）
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
# Cloud Run / Render は PORT を環境変数で渡してくる
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
