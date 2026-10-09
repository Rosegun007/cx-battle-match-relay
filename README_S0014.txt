CX Battle — S0014 测试账号登录服务器
=================================
发行版本：服务端 S0014；客户端 S0014-0001-1
通信协议：CX_ORDERED_RELAY_S0014_V1
战斗模拟核心：CX_SIM_30HZ_ORDERED_INPUT_439_V1（不变）
战斗规则：S0005-0455（不变）

四个账号 test001 / test002 / test003 / test004，统一测试密码 Cx_1234567。
该密码在测试客户端内固定，仅用于原型验证，严禁用于正式运营。
登录要求 HTTPS POST /api/test-login，JSON {user,pw}，不会将密码置于 URL 查询字符串。
成功后回传 12 小时有效的随机会话令牌；客户端仅在服务器确认后移除白色登录层。
联机 join_queue 在服务器 D1 校验令牌，并拒绝同一账号同时占据不同连接的匹配队列/对局。
本版本仅创建基础玩家信息与身份会话，不实现战绩结算、断线判负入库。

【Cloudflare 部署前先建立 D1】
1. 在本目录执行 npm install。
2. 执行 npx wrangler d1 create cx-battle-players。
3. 将命令返回的 database_id 填入 wrangler.jsonc 中的
   REPLACE_WITH_CREATED_D1_DATABASE_ID。
4. 执行 npx wrangler d1 execute cx-battle-players --remote --file=./schema.sql。
   SQL 使用 CREATE TABLE IF NOT EXISTS / INSERT OR IGNORE，重复执行不会重置战绩。
5. 执行 npm run deploy（发布到原有 Worker cx-battle-match-relay）。
6. 先在浏览器访问 https://cx-battle-match-relay.rosegun-chen.workers.dev/
   核对 serviceVersion 为 S0014，再加载两个 S0014-0001-1 客户端。

【交付结构】
src/index.js：所有服务器运行代码（原 delay_rules.js 已合并）
schema.sql：D1 建表及4个预置账号
wrangler.jsonc：Workers + Durable Objects + D1 配置
package.json：部署依赖配置

【安全边界】
四个账号共享密码，且密码存在测试客户端源码中，任何拿到 HTML 的人都可能冒用测试账号。
仅在受控联机测试环境使用，公开发行前须更换为真正的账号认证并限制异常登录请求。
会话令牌并未写入浏览器长期存储，刷新/重新打开 HTML 需要重新选择登录账号。
本次尚未访问或创建你的实际 Cloudflare D1，尚未部署服务器。
