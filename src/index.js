import { DurableObject } from "cloudflare:workers";

const PROTOCOL_VERSION = 1;
const SERVICE_VERSION = "S0002";
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

function errorText(error) {
  if (!error) return "unknown error";
  if (typeof error === "string") return error;
  return String(error.stack || error.message || error);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({
        ok: true,
        service: "cx-battle-match-relay",
        serviceVersion: SERVICE_VERSION,
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

      try {
        const stub = env.CX_MATCH_HUB.getByName(HUB_NAME);
        return await stub.fetch(request);
      } catch (error) {
        const errorId = crypto.randomUUID();
        console.error("[CX:S0002][worker->durable]", errorId, errorText(error));
        return json({
          ok: false,
          service: "cx-battle-match-relay",
          serviceVersion: SERVICE_VERSION,
          error: "durable_object_unavailable",
          errorId,
          serverNow: Date.now(),
        }, 503);
      }
    }

    return json({
      service: "cx-battle-match-relay",
      serviceVersion: SERVICE_VERSION,
      protocol: PROTOCOL_VERSION,
      endpoints: { health: "/health", websocket: "/ws" },
    });
  },
};

export class CXMatchHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sessions = new Map();

    for (const ws of this.ctx.getWebSockets()) {
      const session = ws.deserializeAttachment();
      if (session) this.sessions.set(ws, session);
    }

    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );

    console.log(`[CX:${SERVICE_VERSION}] hub constructor`, {
      restoredConnections: this.sessions.size,
      serverNow: Date.now(),
    });
  }

  async fetch() {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);

    const session = {
      sessionId: crypto.randomUUID(),
      clientId: null,
      ruleVersion: null,
      status: "idle",
      queueOrder: null,
      queuedAt: null,
      roomId: null,
      team: null,
      peerSessionId: null,
      startAt: null,
      connectedAt: Date.now(),
      lastMessageAt: null,
      lastClientSeq: null,
    };

    this.setSession(server, session);
    this.send(server, {
      op: "connected",
      protocol: PROTOCOL_VERSION,
      serviceVersion: SERVICE_VERSION,
      sessionId: session.sessionId,
      serverNow: Date.now(),
    }, "connected");

    console.log(`[CX:${SERVICE_VERSION}] connected`, {
      sessionId: session.sessionId,
      totalConnections: this.sessions.size,
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const startedAt = Date.now();
    let data = null;
    let session = this.sessions.get(ws) || ws.deserializeAttachment();

    try {
      if (typeof message !== "string") {
        this.sendError(ws, "binary_not_supported", "第一版只接受 JSON 文本消息。");
        return;
      }

      try {
        data = JSON.parse(message);
      } catch {
        this.sendError(ws, "bad_json", "消息不是合法 JSON。");
        return;
      }

      if (!session) {
        this.sendError(ws, "missing_session", "服务器找不到当前连接会话。");
        return;
      }

      const touched = { ...session, lastMessageAt: startedAt };
      this.setSession(ws, touched);
      session = touched;

      console.log(`[CX:${SERVICE_VERSION}] message`, {
        op: data?.op ?? null,
        sessionId: session.sessionId,
        roomId: session.roomId,
        team: session.team,
        clientSeq: data?.clientSeq ?? null,
        serverNow: startedAt,
      });

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
          this.send(ws, {
            op: "pong",
            clientNow: data.clientNow ?? null,
            serverNow: Date.now(),
          }, "pong");
          break;
        default:
          this.sendError(ws, "unknown_op", `未知 op：${String(data?.op)}`);
          break;
      }
    } catch (error) {
      const errorId = crypto.randomUUID();
      const detail = errorText(error);
      console.error(`[CX:${SERVICE_VERSION}] unhandled websocket message error`, {
        errorId,
        detail,
        op: data?.op ?? null,
        sessionId: session?.sessionId ?? null,
        roomId: session?.roomId ?? null,
        team: session?.team ?? null,
        clientSeq: data?.clientSeq ?? null,
        serverNow: Date.now(),
      });

      this.send(ws, {
        op: "server_error",
        protocol: PROTOCOL_VERSION,
        serviceVersion: SERVICE_VERSION,
        errorId,
        code: "unhandled_message_error",
        message: "服务器处理该消息时发生异常；连接保持打开，可继续测试。",
        sourceOp: data?.op ?? null,
        clientSeq: data?.clientSeq ?? null,
        serverNow: Date.now(),
      }, "server_error");
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    const session = this.sessions.get(ws) || ws.deserializeAttachment();
    console.log(`[CX:${SERVICE_VERSION}] websocket close`, {
      sessionId: session?.sessionId ?? null,
      roomId: session?.roomId ?? null,
      team: session?.team ?? null,
      code,
      reason: reason || "",
      wasClean: !!wasClean,
      serverNow: Date.now(),
    });
    await this.handleDisconnect(ws, code, reason || "closed", !!wasClean);
  }

  async webSocketError(ws, error) {
    const session = this.sessions.get(ws) || ws.deserializeAttachment();
    console.error(`[CX:${SERVICE_VERSION}] websocket error`, {
      sessionId: session?.sessionId ?? null,
      roomId: session?.roomId ?? null,
      team: session?.team ?? null,
      detail: errorText(error),
      serverNow: Date.now(),
    });
    // 不在 error 回调中重复清理；close 回调负责唯一的房间清理路径。
  }

  async handleJoinQueue(ws, session, data) {
    if (session.status === "matched") {
      this.sendError(ws, "already_matched", "当前连接已经在房间中。");
      return;
    }

    if (session.status === "waiting") {
      this.send(ws, {
        op: "queued",
        protocol: PROTOCOL_VERSION,
        ticketId: `q_${session.queueOrder}`,
        queueOrder: session.queueOrder,
        serverNow: Date.now(),
      }, "queued-repeat");
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
    }, "queued");

    console.log(`[CX:${SERVICE_VERSION}] queued`, {
      sessionId: next.sessionId,
      queueOrder,
      ruleVersion: next.ruleVersion,
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
    this.send(ws, { op: "queue_left", serverNow: Date.now() }, "queue_left");
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

      const common = {
        op: "match_found",
        protocol: PROTOCOL_VERSION,
        serviceVersion: SERVICE_VERSION,
        roomId,
        serverNow,
        startAt,
      };

      this.send(blueWs, {
        ...common,
        seat: 1,
        team: "blue",
        opponentRuleVersion: redSession.ruleVersion ?? null,
      }, "match_found_blue");

      this.send(redWs, {
        ...common,
        seat: 2,
        team: "red",
        opponentRuleVersion: blueSession.ruleVersion ?? null,
      }, "match_found_red");

      console.log(`[CX:${SERVICE_VERSION}] matched`, {
        roomId,
        blueSessionId: blueSession.sessionId,
        redSessionId: redSession.sessionId,
        startAt,
      });
    }
  }

  async handleDeploy(ws, session, data) {
    if (session.status !== "matched" || !session.roomId || !session.team) {
      this.sendError(ws, "not_in_room", "当前连接尚未进入对战房间。");
      return;
    }

    const roomId = session.roomId;
    const clientSeq = data.clientSeq ?? null;
    const serverSeq = await this.nextCounter(`roomSeq:${roomId}`);
    const serverReceivedAt = Date.now();
    const applyAt = serverReceivedAt + RELAY_DELAY_MS;

    const nextSession = { ...session, lastClientSeq: clientSeq };
    this.setSession(ws, nextSession);

    // S0002：明确给发起端一个 ACK。它只是证明“服务器已接收并编号”，
    // 不代表服务器已校验该部署是否合法；第一阶段仍完全不做游戏规则校验。
    this.send(ws, {
      op: "deploy_ack",
      protocol: PROTOCOL_VERSION,
      serviceVersion: SERVICE_VERSION,
      roomId,
      team: session.team,
      clientSeq,
      serverSeq,
      serverReceivedAt,
      applyAt,
      serverNow: Date.now(),
    }, "deploy_ack");

    const event = {
      op: "deploy_event",
      protocol: PROTOCOL_VERSION,
      serviceVersion: SERVICE_VERSION,
      roomId,
      serverSeq,
      team: session.team,
      clientSeq,
      serverReceivedAt,
      applyAt,
      action: data.action ?? null,
    };

    const delivered = this.broadcastRoom(roomId, event);

    console.log(`[CX:${SERVICE_VERSION}] deploy relayed`, {
      roomId,
      team: session.team,
      clientSeq,
      serverSeq,
      serverReceivedAt,
      applyAt,
      delivered,
      action: data.action ?? null,
    });
  }

  async handleDisconnect(ws, code, reason, wasClean = false) {
    const session = this.sessions.get(ws) || ws.deserializeAttachment();
    this.sessions.delete(ws);
    if (!session) return;

    if (session.status === "matched" && session.roomId) {
      for (const [peerWs, peerSession] of this.sessions.entries()) {
        if (peerSession?.roomId !== session.roomId) continue;
        if (peerSession.sessionId !== session.peerSessionId) continue;

        this.send(peerWs, {
          op: "opponent_left",
          protocol: PROTOCOL_VERSION,
          serviceVersion: SERVICE_VERSION,
          roomId: session.roomId,
          code,
          reason,
          wasClean,
          serverNow: Date.now(),
        }, "opponent_left");

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
    let delivered = 0;
    for (const [ws, session] of this.sessions.entries()) {
      if (session?.status === "matched" && session.roomId === roomId) {
        if (this.send(ws, payload, `broadcast:${payload?.op || "unknown"}`)) delivered++;
      }
    }
    return delivered;
  }

  setSession(ws, session) {
    this.sessions.set(ws, session);
    ws.serializeAttachment(session);
  }

  send(ws, payload, label = "send") {
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch (error) {
      const session = this.sessions.get(ws) || ws.deserializeAttachment();
      console.error(`[CX:${SERVICE_VERSION}] websocket send failed`, {
        label,
        sessionId: session?.sessionId ?? null,
        roomId: session?.roomId ?? null,
        team: session?.team ?? null,
        op: payload?.op ?? null,
        detail: errorText(error),
        serverNow: Date.now(),
      });
      return false;
    }
  }

  sendError(ws, code, message) {
    this.send(ws, {
      op: "error",
      protocol: PROTOCOL_VERSION,
      serviceVersion: SERVICE_VERSION,
      code,
      message,
      serverNow: Date.now(),
    }, `error:${code}`);
  }

  async nextCounter(key) {
    const current = (await this.ctx.storage.get(key)) || 0;
    const next = current + 1;
    await this.ctx.storage.put(key, next);
    return next;
  }
}
