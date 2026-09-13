# CX对战 Cloudflare 联机握手/转发服务器 S0006

## S0006 新增：服务器权威起始随机种子

- 每次匹配成功创建房间时，由 Cloudflare 服务器使用 `crypto.getRandomValues()` 生成一个**非零 32 位 `matchSeed`**。
- 同一房间的蓝方、红方在 `match_found` 中收到**完全相同的 `matchSeed`**；服务器将该值持久化到房间状态。
- 服务器**只负责随机性的起点**，不会生成或逐项转发整个随机数流。双方客户端收到同一个 `matchSeed` 后，继续使用现有确定性 PRNG 在本地展开随机流。
- 客户端仍保留“战斗裁判 RNG / AI RNG 分流”；真人联机不运行本地 AI，因此不会让 AI 调用污染战斗 RNG。
- 断线恢复时，`resume_ready` 会再次携带原房间的同一个 `matchSeed`；客户端会核对，不一致则拒绝继续，防止随机流分叉。
- `/health` 新增 `rngAuthority: "server-match-seed/client-deterministic-expansion"` 供部署核查。
- 不改变现有 `serverSeq / applyTick / RTT 保护窗 / 30秒断线恢复` 机制。

## 浏览器部署

继续使用原 GitHub 仓库 `cx-battle-match-relay`：

1. 解压 S0006 ZIP。
2. GitHub 仓库 → Add file → Upload files。
3. 上传并覆盖：`src/`、`package.json`、`wrangler.jsonc`、`README_浏览器部署.md`。
4. Commit changes 到 `main`。
5. Cloudflare 已连接 GitHub 时会自动部署。
6. 部署后访问：
   `https://cx-battle-match-relay.rosegun-chen.workers.dev/health`
7. 确认返回 `"serviceVersion": "S0006"`。

`wrangler.jsonc` 的 Durable Object 类和 migration 不需要新增或手工修改；S0006 继续复用既有 `CXMatchHub` SQLite-backed Durable Object。
