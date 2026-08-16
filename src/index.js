import { DurableObject } from "cloudflare:workers";

const PROTOCOL_VERSION = 1;
const MATCH_START_DELAY_MS = 5000;
const RELAY_DELAY_MS = 150;
const HUB_NAME = "cx-global-match-hub-v1";

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({
        ok: true,
        service: "cx-battle-match-relay",
        protocol: PROTOCOL_VERSION,
        serverNow: Date.now(),
      });
    }

    if (url.pathname === "/ws") {
      const upgrade = request.headers.get("Upgrade");
      if (!upgrade || upgrade.toLowerCase() !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }
      if (request.method !== "GET") {
        return new Response("Expected GET", { status: 405 });
      }

      // 第一阶段自测：所有连接都进入同一个全局 MatchHub。
      // 后续正式化时，可拆成 Matchmaker + 每房间一个 Durable Object。
      const stub = env.CX_MATCH_HUB.getByName(HUB_NAME);
      return stub.fetch(request);
    }

    return json({
      service: "cx-battle-match-relay",
      protocol: PROTOCOL_VERSION,
      endpoints: {
        health: "/health",
        websocket: "/ws",
      },
    });
  },
};

export class CXMatchHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sessions = new Map();

    // Durable Object 从休眠中恢复后，从 WebSocket attachment 恢复会话状态。
    for (const ws of this.ctx.getWebSockets()) {
      const session = ws.deserializeAttachment();
      if (session) this.sessions.set(ws, session);
    }

    // 纯字符串 ping/pong 可由 Cloudflare 在休眠状态下自动回复，不唤醒 JS。
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }

  async fetch() {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);

    const session = {
      sessionId: crypto.randomUUID(),
      clientId: null,
      ruleVersion: null,
      status: "idle", // idle | waiting | matched
      queueOrder: null,
      queuedAt: null,
      roomId: null,
      team: null,
      peerSessionId: null,
      startAt: null,
    };

    this.setSession(server, session);
    this.send(server, {
      op: "connected",
      protocol: PROTOCOL_VERSION,
      sessionId: session.sessionId,
      serverNow: Date.now(),
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== "string") {
      this.sendError(ws, "binary_not_supported", "第一版只接受 JSON 文本消息。");
      return;
    }

    let data;
    try {
      data = JSON.parse(message);
    } catch {
      this.sendError(ws, "bad_json", "消息不是合法 JSON。");
      return;
    }

    const session = this.sessions.get(ws) || ws.deserializeAttachment();
    if (!session) {
      this.sendError(ws, "missing_session", "服务器找不到当前连接会话。");
      return;
    }

    switch (data?.op) {
      case "join_queue":
        await this.handleJoinQueue(ws, session, data);
        break;

      case "leave_queue":
        this.handleLeaveQueue(ws, session);
        break;

      case "deploy":
        await this.handleDeploy(ws, session, data);
        break;

      case "ping":
        // JSON ping 用于客户端测量 RTT / 时钟偏差。
        this.send(ws, {
          op: "pong",
          clientNow: data.clientNow ?? null,
          serverNow: Date.now(),
        });
        break;

      default:
        this.sendError(ws, "unknown_op", `未知 op：${String(data?.op)}`);
        break;
    }
  }

  async webSocketClose(ws, code, reason) {
    await this.handleDisconnect(ws, code, reason || "closed");
  }

  async webSocketError(ws, error) {
    await this.handleDisconnect(ws, 1011, String(error?.message || error || "websocket error"));
  }

  async handleJoinQueue(ws, session, data) {
    if (session.status === "matched") {
      this.sendError(ws, "already_matched", "当前连接已经在房间中。");
      return;
    }

    // 同一个连接重复点击排队，不重复插队。
    if (session.status === "waiting") {
      this.send(ws, {
        op: "queued",
        protocol: PROTOCOL_VERSION,
        ticketId: `q_${session.queueOrder}`,
        queueOrder: session.queueOrder,
        serverNow: Date.now(),
      });
      return;
    }

    const queueOrder = await this.nextCounter("queueOrder");
    const next = {
      ...session,
      clientId: String(data.clientId || session.sessionId),
      ruleVersion: data.ruleVersion == null ? null : String(data.ruleVersion),
      status: "waiting",
      queueOrder,
      queuedAt: Date.now(),
      roomId: null,
      team: null,
      peerSessionId: null,
      startAt: null,
    };

    this.setSession(ws, next);
    this.send(ws, {
      op: "queued",
      protocol: PROTOCOL_VERSION,
      ticketId: `q_${queueOrder}`,
      queueOrder,
      serverNow: Date.now(),
    });

    await this.tryMatchWaitingPlayers();
  }

  handleLeaveQueue(ws, session) {
    if (session.status !== "waiting") return;
    const next = {
      ...session,
      status: "idle",
      queueOrder: null,
      queuedAt: null,
    };
    this.setSession(ws, next);
    this.send(ws, { op: "queue_left", serverNow: Date.now() });
  }

  async tryMatchWaitingPlayers() {
    const waiting = [...this.sessions.entries()]
      .filter(([, s]) => s?.status === "waiting")
      .sort((a, b) => (a[1].queueOrder ?? Infinity) - (b[1].queueOrder ?? Infinity));

    while (waiting.length >= 2) {
      const [blueWs, blueSession] = waiting.shift();
      const [redWs, redSession] = waiting.shift();

      const roomNo = await this.nextCounter("roomNo");
      const roomId = `CX_${String(roomNo).padStart(6, "0")}_${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
      const serverNow = Date.now();
      const startAt = serverNow + MATCH_START_DELAY_MS;

      const blueNext = {
        ...blueSession,
        status: "matched",
        roomId,
        team: "blue",
        peerSessionId: redSession.sessionId,
        startAt,
      };
      const redNext = {
        ...redSession,
        status: "matched",
        roomId,
        team: "red",
        peerSessionId: blueSession.sessionId,
        startAt,
      };

      this.setSession(blueWs, blueNext);
      this.setSession(redWs, redNext);

      this.send(blueWs, {
        op: "match_found",
        protocol: PROTOCOL_VERSION,
        roomId,
        seat: 1,
        team: "blue",
        serverNow,
        startAt,
        opponentRuleVersion: redSession.ruleVersion ?? null,
      });

      this.send(redWs, {
        op: "match_found",
        protocol: PROTOCOL_VERSION,
        roomId,
        seat: 2,
        team: "red",
        serverNow,
        startAt,
        opponentRuleVersion: blueSession.ruleVersion ?? null,
      });
    }
  }

  async handleDeploy(ws, session, data) {
    if (session.status !== "matched" || !session.roomId || !session.team) {
      this.sendError(ws, "not_in_room", "当前连接尚未进入对战房间。");
      return;
    }

    // 第一阶段明确不做游戏合法性校验：
    // 不检查能量、位置、阵营半场、炮台数量、部署前摇等；只做房间路由和转发。
    const roomId = session.roomId;
    const serverSeq = await this.nextCounter(`roomSeq:${roomId}`);
    const serverReceivedAt = Date.now();
    const applyAt = serverReceivedAt + RELAY_DELAY_MS;

    const event = {
      op: "deploy_event",
      protocol: PROTOCOL_VERSION,
      roomId,
      serverSeq,
      team: session.team,
      clientSeq: data.clientSeq ?? null,
      serverReceivedAt,
      applyAt,
      action: data.action ?? null,
    };

    this.broadcastRoom(roomId, event);
  }

  async handleDisconnect(ws, code, reason) {
    const session = this.sessions.get(ws) || ws.deserializeAttachment();
    this.sessions.delete(ws);
    if (!session) return;

    if (session.status === "matched" && session.roomId) {
      for (const [peerWs, peerSession] of this.sessions.entries()) {
        if (peerSession?.roomId !== session.roomId) continue;
        if (peerSession.sessionId !== session.peerSessionId) continue;

        this.send(peerWs, {
          op: "opponent_left",
          roomId: session.roomId,
          code,
          reason,
          serverNow: Date.now(),
        });

        this.setSession(peerWs, {
          ...peerSession,
          status: "idle",
          queueOrder: null,
          queuedAt: null,
          roomId: null,
          team: null,
          peerSessionId: null,
          startAt: null,
        });
        break;
      }
    }
  }

  broadcastRoom(roomId, payload) {
    for (const [ws, session] of this.sessions.entries()) {
      if (session?.status === "matched" && session.roomId === roomId) {
        this.send(ws, payload);
      }
    }
  }

  setSession(ws, session) {
    this.sessions.set(ws, session);
    ws.serializeAttachment(session);
  }

  send(ws, payload) {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // 断线会由 close/error 事件负责清理；发送失败时不让整个 Hub 崩溃。
    }
  }

  sendError(ws, code, message) {
    this.send(ws, {
      op: "error",
      code,
      message,
      serverNow: Date.now(),
    });
  }

  async nextCounter(key) {
    const current = (await this.ctx.storage.get(key)) || 0;
    const next = current + 1;
    await this.ctx.storage.put(key, next);
    return next;
  }
}
