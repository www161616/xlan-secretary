# 小瀾常駐服務（NAS 版）映像。
# 安全：以非 root 的內建 `node` 使用者執行（最小權限），不在 root 下跑 Node 服務。
FROM node:20-slim
WORKDIR /app

# 先只複製 package 檔做相依安裝，最大化 layer 快取。
# 用 npm ci（依 package-lock.json 可重現安裝）；lock 已含 express / node-cron，不會因 lock 不齊而失敗。
# --chown=node:node：讓 node 使用者擁有這些檔案。
COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev

# 複製其餘原始碼（同樣交給 node 使用者），.dockerignore 已排除 node_modules / 本機工具狀態 / 文件。
COPY --chown=node:node . .

EXPOSE 3000

# 切到非 root 使用者後才啟動服務。
USER node
CMD ["node", "server.js"]
