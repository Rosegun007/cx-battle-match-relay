CX 对战：Cloudflare 联机服务器 S0012
对应客户端：S0012-0001-1

【本轮功能】
1. 服务器在 WebSocket 连接建立后主动发起3次应用层 clock_probe（随机 nonce），客户端逐次 clock_probe_reply，服务器记录每次 RTT（服务器发出与收到的时间，非客户端自报）。完成3次以后才能 join_queue。
2. 客户端利用四个时间戳估算服务器时钟偏移，仍采用最小 RTT 样本，但双方正式匹配使用的新协议为 CX_ORDERED_RELAY_S0012_V1。
3. 比赛双方独立进行约1秒一次的应用层心跳。服务器发出随机挑战 Token，客户端下一次心跳回执；服务器同时记录每一侧的入站消息时间和已验证双向回执时间。
4. 一侧 WebSocket 关闭或3秒无上行/双向回执时，服务器先记录案件、冻结操作、观察1000ms；随后检查另一侧是否保持可验证通信。
5. 只有能确认另一方仍正常通信，才将首个失联侧列为 responsibleTeam；双方几乎同时失联、正常方没有可信回执等情形统一 Unknown。
6. 结案前将服务器证据保存到当前 Cloudflare Durable Object 存储的 disconnect-evidence:* 键中（最多保留最新64条，按时间淘汰）。这不是天梯数据库，不涉及分数。
7. 沿用此前 S0011 的80% Windup、三段延迟责任、操作合法性验证和网络 Hash 校验不变。分别以 transition=delay / transition=disconnect 结案，避免重复弹框。
8. 无重新连接续赛机制，无自动转人机。

【重要边界】
- 服务器可以证明某一侧连接或双向心跳失效，但不能证明当事人有主观故意，也不能查明 ISP/网络设备物理故障的实际根因。按玩家连接风险分配责任属于游戏规则，而不是网络故障科学归因。
- 已经彻底断线的一方无法收到服务器结果；对方仍在线时可收到 Enemy Disconnect / Unknown Disconnect。彻底断线方本地先显示 Connection Lost。
- 没有 DB，不涉及积分增减；DO 中的证据仅保留最近64件。
- 旧版 S0011 与新版 S0012 握手协议不兼容。请在没有活跃对局时部署 S0012，然后使用 S0012-0001-1 双端测试。
- 本轮进行了 Mock WebSocket/DO 存储测试与 Chromium 页面加载测试，尚未在 Cloudflare 线上环境部署，也未做手机网络切换的真机测试。务必先测试服验证。

【建议的测试顺序】
A. 双端新客户端正常连接。服务器完成3次 Ping 后进入匹配、战前30秒倒计时、正式战斗，检查延迟/ACK/Hash 正常。
B. A 拔掉 Wi-Fi/4G（B 保持正常），B 应见 Enemy Disconnect，A 见 Connection Lost（或尚未收到事件）；双方几乎同时断网则服务器记录 Unknown。
C. B 的服务端回执故意丢失但 B 仍发心跳，按服务器双向回执超时判 B 连接侧异常。
D. 仅模拟超过80% Windup 的操作超时，仍应显示 Your Delay/Enemy Delay/Unknown Delay，不被断线案件替换。
E. 核实三种断线结果与延迟结果的对话框按钮固定为 Save Record / Rematch / Options，战前无记录时 Save Record 禁用。

【本地测试】
在含 Node.js 22 的目录执行：
node tests/test_s0012_disconnect.mjs
node tests/test_s0012_delay_regression.mjs
node tests/test_client_dialogs.mjs
客户端 UI 测试需要额外提供客户端 HTML 路径；例如 node tests/test_client_dialogs.mjs /path/to/CXBattle_Client_S0012-0001-1_ServerPing_DisconnectVerdict.html。单独解压服务器 ZIP 时可运行其余两项测试。

【部署】
原 wrangler.jsonc 的 Cloudflare Workers / Durable Object 绑定不变。
在服务器源码目录运行 npm install 与 npm run deploy（或你原来的 Wrangler 部署方式）。
该操作需要使用你自己的 Cloudflare 账号，本包未替你执行线上部署。

【版本修正声明】
本版仅将上一轮成果的服务器版本 S0011-1 更正为 S0012、客户端版本 S0011-0001-2 更正为 S0012-0001-1，双方握手 WIRE 同步改为 CX_ORDERED_RELAY_S0012_V1。战斗规则 CX_RULE_VERSION、CORE、Cloudflare Durable Object 命名和实际联机逻辑均不变。
