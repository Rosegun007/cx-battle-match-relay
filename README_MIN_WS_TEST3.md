# S0005 MIN_WS_TEST3

`/ws` 严格采用 Cloudflare 官方最小 101 Upgrade：

1. `new WebSocketPair()`
2. `server.accept()`
3. `return new Response(null, { status: 101, webSocket: client })`

不在 101 前发送消息，不注册事件，不调用 Durable Object。保留 DO 绑定和类定义仅为了维持现有部署结构。

部署后 `/health` 应显示 `mode: MIN_WS_TEST3_OFFICIAL_BARE_101`。
