# CX对战 Cloudflare 联机握手/转发服务器 S0002

S0002 在 S0001 的配对/建房/转发逻辑基础上，只增加诊断能力，不增加服务器端游戏合法性校验。

新增：
- `/health` 返回 `serviceVersion: "S0002"`。
- 每次连接有 `sessionId`。
- `deploy` 被服务器接收并编号后，发起端会额外收到 `deploy_ack`。
- 所有 WebSocket 消息总入口有 try/catch；单条消息处理异常会返回 `server_error`，尽量不让整个连接因未捕获异常中断。
- Cloudflare Workers Logs 中记录：连接、排队、配对、deploy、广播数量、close code/reason/wasClean、异常。
- `webSocketError` 只记日志，房间清理由 `webSocketClose` 单一路径完成，避免重复清理。

## 从 S0001 更新（纯浏览器）
1. 解压本 ZIP。
2. 在 GitHub 仓库 `cx-battle-match-relay` 中选择 **Add file → Upload files**。
3. 把解压后的 `src` 文件夹、`package.json`、`wrangler.jsonc`、本 README 拖进去，覆盖同名文件。
4. Commit changes 到 `main`。
5. Cloudflare 已连接 GitHub，应自动触发部署，无需在 Windows 安装 Node/Wrangler。
6. 部署结束后访问：
   `https://cx-battle-match-relay.rosegun-chen.workers.dev/health`
   应看到 `"serviceVersion": "S0002"`。

注意：Durable Object 类名和 migration 没变，仍使用原 v1 migration；不要新建第二个 Durable Object。
