CX对战 Cloudflare 联机握手转发服务器 S0005-DIAG1

目的：只增加诊断入口，不改原 /ws 联机协议、不改 serviceVersion（仍为 S0005）。

新增入口：
1) https://cx-battle-match-relay.rosegun-chen.workers.dev/diag
   应返回 diagBuild = S0005-DIAG1。

2) https://cx-battle-match-relay.rosegun-chen.workers.dev/diag/do-http
   普通 HTTP：Worker -> CX_MATCH_HUB Durable Object。
   正常应返回 ok:true, component:"CXMatchHub"。

3) wss://cx-battle-match-relay.rosegun-chen.workers.dev/diag/ws-direct
   WebSocket：普通 Worker 直接 101，不经过 Durable Object。
   Chrome Console 测试：

   const d = new WebSocket("wss://cx-battle-match-relay.rosegun-chen.workers.dev/diag/ws-direct");
   d.onopen=()=>console.log("DIRECT OPEN");
   d.onmessage=e=>console.log("DIRECT MSG",e.data);
   d.onerror=e=>console.log("DIRECT ERROR",e);
   d.onclose=e=>console.log("DIRECT CLOSE",e.code,e.reason,e.wasClean);

判读：
A. /diag/do-http 成功，/diag/ws-direct 成功，而原 /ws 失败
   => 故障集中在 Durable Object 的 WebSocket Upgrade/转发路径。

B. /diag/do-http 成功，但 /diag/ws-direct 失败
   => Durable Object 绑定正常；该 workers.dev hostname/Worker 的 WebSocket Upgrade 路径异常。

C. /diag/do-http 失败
   => Worker -> CX_MATCH_HUB Durable Object 调用/绑定本身异常。

D. /diag/ws-direct 成功，但 /diag/do-http 失败
   => WebSocket/hostname 正常；Durable Object 调用链异常。
