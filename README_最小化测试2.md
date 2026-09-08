# S0005 MIN_WS_TEST2（保留 Durable Object 绑定版）

用途：验证 `cx-battle-match-relay.rosegun-chen.workers.dev` 本身能否完成 WebSocket Upgrade。

与上一版 MIN_WS_TEST 的关键区别：
- **保留原 `wrangler.jsonc` 中 CX_MATCH_HUB Durable Object 绑定与 migration**；
- **保留原 `CXMatchHub` 类定义**；
- `/ws` **不调用 Durable Object**，直接由 Worker 创建 `WebSocketPair` 并返回 101；
- `/health` 会显示 `mode: "MIN_WS_TEST2_KEEP_DO_BINDING"`。

这样既不删除现有 Durable Object，也不触发 DO 删除迁移，同时仍能把 `/ws` 与 DO 完全隔离。
