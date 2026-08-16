# CX 对战 Cloudflare 握手 / 配对 / 转发服务器 S0001

用途：自家真人联机测试第一阶段。

功能：
- WebSocket 握手
- FIFO 1 对 1 自动配对
- 自动创建 roomId
- 第一个排队者 = 蓝方，第二个 = 红方
- 双方收到同一个约 5 秒后的 `startAt`
- 暂不做服务器端游戏规则校验
- 服务器为每个部署事件分配 `serverSeq`、`applyAt`，再同时广播给房间双方
- 对手断线通知
- 使用 Durable Objects WebSocket Hibernation

## 浏览器端部署思路

本包本身不要求你在 Windows 11 上安装 Node、Wrangler 或运行服务器。

当前 Cloudflare 官方 Dashboard 文档支持从 GitHub/GitLab 仓库导入 Worker 项目并部署。由于 Durable Object 需要同时上传代码和 wrangler 配置，最稳妥的“纯浏览器部署”流程是：

1. 在 GitHub 网页中新建一个空仓库，例如 `cx-battle-match-relay`。
2. 在 GitHub 网页里把本目录下的：
   - `src/index.js`
   - `wrangler.jsonc`
   - `package.json`
   上传到仓库，并保持 `src/index.js` 的目录结构。
3. 打开 Cloudflare Dashboard → Workers & Pages → Create application。
4. 选择 Import an existing Git repository，连接刚才的 GitHub 仓库。
5. 部署。项目已经带 `wrangler.jsonc`，其中包含 Durable Object binding 和 SQLite class migration。
6. 部署完成后会得到类似：
   `https://cx-battle-match-relay.<你的子域>.workers.dev`
7. 浏览器打开：
   `https://cx-battle-match-relay.<你的子域>.workers.dev/health`
   如果看到 `"ok": true`，服务器已上线。
8. WebSocket 地址就是：
   `wss://cx-battle-match-relay.<你的子域>.workers.dev/ws`

## 手机客户端

客户端最终运行在手机浏览器时仍使用标准 WebSocket：

```js
const ws = new WebSocket("wss://cx-battle-match-relay.<你的子域>.workers.dev/ws");
```

Android Chrome、iPhone Safari 等现代浏览器均可使用标准 WebSocket。手机不需要安装 Cloudflare、Node 或任何服务器软件。

## 第一版消息

### 加入队列
```json
{
  "op": "join_queue",
  "protocol": 1,
  "game": "cx-battle",
  "ruleVersion": "A0272",
  "clientId": "client-001"
}
```

### 服务器：排队
```json
{
  "op": "queued",
  "ticketId": "q_1",
  "queueOrder": 1,
  "serverNow": 1786891200123
}
```

### 服务器：匹配成功
```json
{
  "op": "match_found",
  "roomId": "CX_000001_ABC123",
  "seat": 1,
  "team": "blue",
  "serverNow": 1786891205000,
  "startAt": 1786891210000
}
```

### 客户端：部署
```json
{
  "op": "deploy",
  "roomId": "CX_000001_ABC123",
  "clientSeq": 17,
  "action": {
    "unit": "tank",
    "mode": "normal",
    "x": 6,
    "y": 25
  }
}
```

### 服务器：正式部署事件（同时发给双方）
```json
{
  "op": "deploy_event",
  "roomId": "CX_000001_ABC123",
  "serverSeq": 38,
  "team": "red",
  "clientSeq": 17,
  "serverReceivedAt": 1786891223124,
  "applyAt": 1786891223274,
  "action": {
    "unit": "tank",
    "mode": "normal",
    "x": 6,
    "y": 25
  }
}
```
