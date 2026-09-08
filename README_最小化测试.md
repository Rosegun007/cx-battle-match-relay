# cx-battle-match-relay 最小 WebSocket 测试版

用途：临时把现有 `cx-battle-match-relay` 最小化，直接测试同一个 workers.dev 域名的 WebSocket Upgrade。

- 保留 Worker 名：`cx-battle-match-relay`
- 保留 `/health`
- 保留 `/ws`
- 删除 Durable Object、匹配、房间、重连等全部逻辑
- `/ws` 直接在 Worker 内用 `WebSocketPair` 返回 101

部署后测试：

```js
const ws = new WebSocket("wss://cx-battle-match-relay.rosegun-chen.workers.dev/ws");
ws.onopen = () => console.log("✅ WS OPEN");
ws.onmessage = e => console.log("📨", e.data);
ws.onerror = e => console.log("❌ WS ERROR", e);
ws.onclose = e => console.log("🔴 WS CLOSE", e.code, e.reason, e.wasClean);
```

正常应出现 `✅ WS OPEN`，并收到 `mode":"MIN_WS_TEST"` 的 connected 消息。

测试完成后，请恢复原 S0005 服务器代码；本版本不提供真实匹配功能。
