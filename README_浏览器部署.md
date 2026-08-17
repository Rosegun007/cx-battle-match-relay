# CX对战 Cloudflare 联机握手/转发服务器 S0004

## S0004 新增

- **修复恢复后部署延迟异常**：S0003 的 `deploy_event.applyAt` 是真实墙钟时间，而客户端恢复后模拟时钟已经回退到 `resumeTick`，若仍从最初 `startAt` 换算，会把断线暂停的真实时间错误计入部署等待。
- S0004 为房间持久化当前模拟时钟 epoch：`clockBaseTick + clockBaseServerAt`。
- 每次恢复时把 epoch 更新为 `resumeTick + resumeAt`；恢复后的新部署由服务器直接计算并广播权威 `applyTick`。
- `deploy_ack` 同样携带 `applyTick`，便于诊断。
- 新房间和从 S0003 平滑升级后的活动房间都提供时钟基线兼容。

- 30 秒短时断线恢复宽限。
- 任意一方异常断线后，房间进入 suspended，另一方收到 `peer_reconnecting`，双方客户端应暂停。
- 匹配时为 blue/red 各自发放独立 `resumeToken`。
- 掉线方新 WebSocket 连接后发送 `resume_match`，可重新绑定原房间和原阵营。
- 双方都在线后服务器发送 `resume_ready`：约 2.5 秒后从共同安全 `resumeTick` 继续。
- 客户端在每个新的整秒确定性快照产生后发送一次 `sync_heartbeat`，服务器记录 `tick / checkpointTick / lastServerSeq`；避免对同一恢复点重复写存储。
- 恢复点使用双方最近确认的整秒回放快照 Tick 中较小者。
- 房间的正式 `deploy_event` 事件表持久化到 Durable Object Storage；恢复时一并下发，客户端可回滚后重新排入尚未执行的部署。
- 30 秒仍未恢复则通过 Durable Object Alarm 清理房间，在线方收到 `resume_timeout`。
- 主动 `leave_room` / 正常重开不会误触发 30 秒恢复。

## 浏览器部署

继续使用原 GitHub 仓库 `cx-battle-match-relay`：

1. 解压 S0004 ZIP。
2. GitHub 仓库 → Add file → Upload files。
3. 上传并覆盖：`src/`、`package.json`、`wrangler.jsonc`、`README_浏览器部署.md`。
4. Commit changes 到 `main`。
5. Cloudflare 已连接 GitHub 时会自动部署。
6. 部署后访问：
   `https://cx-battle-match-relay.rosegun-chen.workers.dev/health`
7. 确认返回 `"serviceVersion": "S0004"`。

`wrangler.jsonc` 的 Durable Object 类和 migration 不需要新增或手工修改；S0004 继续复用既有 `CXMatchHub` SQLite-backed Durable Object。
