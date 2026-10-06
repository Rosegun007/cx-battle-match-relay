CX对战服务器 S0010，配套客户端 S0010-0001-1。
本包为代码交付，未代为部署线上。
沿用原 Worker 名称 cx-battle-match-relay、CX_MATCH_HUB 绑定、CXMatchHub 类和 v1 migration。
使用原部署账号与项目配置；如用 Wrangler，在本目录安装 package.json 中的依赖后执行 npm run deploy。
已有自定义域名、账号等配置请自行保留。
先更新服务器，再让双方使用新客户端；本版联机协议不兼容 S0009，不迁移进行中的旧对局。
健康信息应为 serviceVersion=S0010，wireProtocol=CX_ORDERED_RELAY_S0010_V1。

新准备流程：
1. 建房时记录同一 preStartAt，作为双方30Hz战前Tick0；预备900 Tick，最后90 Tick锁定。
2. Ready时提交 setup + prepTick；未Ready者在预备Tick810自动提交并锁定。
3. 服务器只检查信封、首次提交一致性与时间范围，原样将配置转发给对方。
4. 服务器及两端均计算 startPreTick=max(双方提交Tick)+90；startAt=preStartAt+startPreTick/30秒。
5. 双方重建完整初态，立即发送 initial_state；服务器比较初始Hash及T0检查点，立即向双方发送 start_confirm，不等待心跳。
6. 预定开战时间不因网络接收变晚而延后。未完成确认则Reconnect。
7. 启动交接未确认完成时，中断按Reconnect处理；正常进入战斗后继续使用已有断网转人机策略。

常规战斗仍为每秒心跳、操作即时relay+ACK、服务器同Tick Hash配对；Waiting心跳10秒；连接失联3秒；检查点确认停滞15秒。
服务器不运行战斗引擎，不承担部署玩法/能量或防作弊验证。
一条连接只参加一局；roomId仅在match_found下发一次。
本版锁定期固定选择3秒；若未来改为5秒，应配套修改并验收客户端和服务端。
