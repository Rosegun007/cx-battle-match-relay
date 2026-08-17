# CX对战 Cloudflare 联机握手/转发服务器 S0005

## S0005 新增

- **修复“断线恢复后，一开始部署双方就进入【联机同步暂停】”**。S0004 虽然已经把恢复后的 `applyTick` 映射到正确的恢复 epoch，但仍沿用固定 150ms 的广播保护窗；VPN/移动网络刚重连时的单程抖动可能超过该窗口，客户端收到事件时已经越过服务器指定 Tick，于是两端的严格防分叉检查会主动暂停。
- S0005 不再固定使用 150ms。服务器记录 blue/red 两端最近报告的 RTT，并按 **最差一端 RTT + 120ms 抖动余量** 动态计算部署保护窗，最少 350ms、最多 1200ms。`deploy_event` / `deploy_ack` 新增 `relayLeadMs` 便于诊断。
- A0284 在断线重新建立 WebSocket 后，不再立刻 `resume_match`；先重新执行 3 次 `ping/pong` 校时并测量当前 RTT，然后携带新 RTT 申请恢复原房间，避免继续沿用掉线前的旧网络估计。
- `join_queue`、`resume_match`、`sync_heartbeat` 均可携带 `rttMs`，房间持久化两席位的最近 RTT。
- 继续保留 S0004 的权威 `applyTick` 与多段模拟时钟 epoch，因此断线暂停的真实墙钟时间不会重新计入模拟 Tick。

### 继续保留的断线恢复机制

- 30 秒短时断线恢复宽限。
- 任意一方异常断线后，房间进入 suspended，另一方收到 `peer_reconnecting`，双方客户端暂停。
- 匹配时为 blue/red 各自发放独立 `resumeToken`。
- 双方都在线后服务器发送 `resume_ready`，约 2.5 秒后从共同安全 `resumeTick` 继续。
- 正式 `deploy_event` 历史保存在 Durable Object Storage；恢复时可重新排入恢复点之后的既有事件。
- 30 秒仍未恢复则通过 Durable Object Alarm 清理房间。

## 浏览器部署

继续使用原 GitHub 仓库 `cx-battle-match-relay`：

1. 解压 S0005 ZIP。
2. GitHub 仓库 → Add file → Upload files。
3. 上传并覆盖：`src/`、`package.json`、`wrangler.jsonc`、`README_浏览器部署.md`。
4. Commit changes 到 `main`。
5. Cloudflare 已连接 GitHub 时会自动部署。
6. 部署后访问：
   `https://cx-battle-match-relay.rosegun-chen.workers.dev/health`
7. 确认返回 `"serviceVersion": "S0005"`。

`wrangler.jsonc` 的 Durable Object 类和 migration 不需要新增或手工修改；S0005 继续复用既有 `CXMatchHub` SQLite-backed Durable Object。
