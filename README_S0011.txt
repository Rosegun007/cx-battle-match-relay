CX对战 Cloudflare 联机服务器 S0011
配套客户端：S0011-0001-1
功能：统一80%合法传输窗口与服务器权威超时责任裁决。

【部署】
1. 本ZIP仅交付代码；并未代为部署到 Cloudflare，也不包含数据库/积分逻辑。
2. 沿用现有 Worker 名称 cx-battle-match-relay、CX_MATCH_HUB 绑定、CXMatchHub 类和原有 v1 migration。
3. 沿用原项目 Cloudflare 账号、自定义域名及 Secrets；在本目录 npm install / npm run deploy。
4. 应先更新服务器 S0011，再让双方统一使用 S0011-0001-1 客户端。
5. 客户端/服务端以 CX_ORDERED_RELAY_S0011_V1 强制版本隔离；S0010 客户端不能与本服务器正常匹配。
6. 正在进行中的 S0010 房间建议自然结束后再切换；此代码没有迁移其历史运行态。
7. 部署后访问 Worker HTTP 入口，确认 serviceVersion=S0011、wireProtocol=CX_ORDERED_RELAY_S0011_V1。

【超时规则】
每个合法操作由服务器根据 src/delay_rules.js 权威规则查完整Windup T，再取 W=floor(T*4/5)。
A发送的合法起始tick：tick_A；服务器实际收到操作时刻对应tick：tick_R；实际转发tick：tick_S。
R_A=min(max(tick_R-tick_A,0),W)
R_S=min(max(tick_S-tick_R,0),W-R_A)
R_B=W-R_A-R_S
R_A>W/2：责任方A；R_B>W/2：责任方B；否则为Unknown。整数按 2*R>W 严格比较。

接收方发现操作超时，通过 timeout_report(inputId)向服务器报告；服务器只认可自己已记录并转发的操作。
未到服务器权威截止tick的报告回复 timeout_report_wait，客户端到期后重试。
服务器在 room_closed 中下发 transition=delay、responsibleTeam（blue/red/null）；客户端本地映射：
自己的责任：Your Delay
对方的责任：Enemy Delay
无法归责任一玩家：Unknown Delay
三种对话框都固定 Save Record / Rematch / Options，Save Record 未形成有效复盘记录时为灰色禁用。

【说明】
- 未提前给所有玩家额外增加固定操作延迟；正常输入仍通过WebSocket即时转发。
- 未启用积分加减与作弊数据库。
- 服务器已转发但客户端声称晚到的报告，属于事先协商的责任预算判定，不证明真实网络单程延迟或主观作弊意图。
- 未转发成功的迟到指令，不会把责任算到从未收到它的接收方。
- 若WebSocket彻底断线/ACK超时/普通连接超时，仍走既有Opponent Offline流程，并非本版三类收到合法操作后的超期报告。
- 此包已通过隔离测试，不等于已完成Cloudflare部署、真实跨设备联机与网络弱网验收。
- IMPORTANT：未来改动 DEPLOY_MODE_RULES 或 BATTLE_FLAG_CONFIG，必须同步更新 src/delay_rules.js 并升级联机规则协议。
