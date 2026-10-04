CX对战联机服务器 S0009
配套客户端：S0009-0001-1。
本包为代码交付，没有代为部署线上。

部署沿用原 Worker 名称 cx-battle-match-relay、CX_MATCH_HUB 绑定、CXMatchHub 类和 v1 migration。
请使用原部署账号和项目配置。在本目录安装 package.json 中依赖后，可执行 npm run deploy。
实际部署若有额外域名、账号等配置，请保留自己的配置。
先更新服务端，再让双方使用新客户端。本版本联机协议不兼容 S0008；不迁移进行中的旧对局。
健康信息应显示 serviceVersion=S0009、wireProtocol=CX_ORDERED_RELAY_S0009_V1。

通信规则：
- 一条 WebSocket 在其生命周期内只能匹配一局；结束/异常后退役并关闭，下一局另建连接。
- match_found 下发一次 roomId。此后常规消息依靠连接绑定定位房间，不重复携带 roomId。
- relay 只转发 input / ack。初始 Hash、稀疏检查点随 heartbeat 上传。
- 服务端按同 Tick 配对 Hash；完整前缀确认后清除相应待配对 Hash。确认进度随心跳回复。
- 终局完整确认后，向双方发出包含最终确认 Tick 的 room_closed（transition=finished），随后关闭两条连接。
- 失步、连接超时、操作超时等异常通知双方转本地人机；终局后的异常由客户端显示未确认。
- 服务端不运行战斗引擎，也不验证部署玩法或防作弊。

参数：战斗心跳1秒；Waiting心跳10秒、失联30秒；战斗连接失联3秒；部署转发预留6 Tick、接入安全余量2 Tick；ACK回程余量30 Tick；时钟偏差上限60 Tick。
新增检查点确认进度停滞超时15秒，独立于连接超时；单方待配对 Hash 上限32条。此为首轮实网验收值。
这些参数统一下发给客户端。战斗保持30 Tick/秒。
