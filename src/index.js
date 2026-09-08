import { DurableObject } from "cloudflare:workers";

const PROTOCOL_VERSION = 1;
const SERVICE_VERSION = "S0005";
const MATCH_START_DELAY_MS = 5000;
const MIN_RELAY_LEAD_MS = 350;
const MAX_RELAY_LEAD_MS = 1200;
const RELAY_JITTER_GUARD_MS = 120;
const SIM_STEP_MS = 1000 / 60;
const RECONNECT_GRACE_MS = 30000;
const RESUME_START_DELAY_MS = 2500;
const MAX_ROOM_EVENTS = 512;
const HUB_NAME = "cx-global-match-hub-v1";
const ROOM_PREFIX = "room:";
const INTENTIONAL_CLOSE_REASONS = new Set(["user", "manual", "rematch", "record-playback", "match-finished"]);

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

function roomKey(roomId) {
  return `${ROOM_PREFIX}${roomId}`;
}

function newResumeToken() {
  return `${crypto.randomUUID()}-${crypto.randomUUID()}`;
}

function roomClockEpoch(room) {
  const hasStored = Number.isFinite(Number(room?.clockBaseServerAt));
  if (hasStored) {
    return {
      baseTick: Math.max(0, Math.floor(Number(room.clockBaseTick) || 0)),
      baseServerAt: Number(room.clockBaseServerAt),
    };
  }
  // S0003活动房间平滑升级兼容：若已经发生过一次恢复，resumingUntil就是当次resumeAt。
  if (Number.isFinite(Number(room?.resumingUntil)) && Number.isFinite(Number(room?.pauseTick))) {
    return {
      baseTick: Math.max(0, Math.floor(Number(room.pauseTick) || 0)),
      baseServerAt: Number(room.resumingUntil),
    };
  }
  return {
    baseTick: 0,
    baseServerAt: Number(room?.startAt) || Date.now(),
  };
}


function normalizedRttMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.max(0, Math.min(2000, n));
}

function roomRelayLeadMs(room) {
  const rtts = [room?.seats?.blue?.rttMs, room?.seats?.red?.rttMs]
    .map(normalizedRttMs)
    .filter((v) => v != null);
  const worstRtt = rtts.length ? Math.max(...rtts) : 0;
  // A0284/S0005：部署事件必须给两端留出真正的网络传播余量。
  // 使用“最差一端完整RTT + 抖动余量”，比仅估算单程更保守，尤其适合VPN/移动网络刚重连后的瞬时抖动。
  return Math.max(MIN_RELAY_LEAD_MS, Math.min(MAX_RELAY_LEAD_MS, Math.ceil(worstRtt + RELAY_JITTER_GUARD_MS)));
}

function roomApplyTick(room, applyAt) {
  const { baseTick, baseServerAt } = roomClockEpoch(room);
  const deltaSteps = Math.ceil(((Number(applyAt) - baseServerAt) / SIM_STEP_MS) - 1e-9);
  return Math.max(baseTick + 1, baseTick + deltaSteps);
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
        reconnectGraceMs: RECONNECT_GRACE_MS,
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
        console.error(`[CX:${SERVICE_VERSION}][worker->durable]`, errorId, errorText(error));
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
      reconnectGraceMs: RECONNECT_GRACE_MS,
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
      resumedFromSessionId: null,
    };

    this.setSession(server, session);
    this.send(server, {
      op: "connected",
      protocol: PROTOCOL_VERSION,
      serviceVersion: SERVICE_VERSION,
      sessionId: session.sessionId,
      reconnectGraceMs: RECONNECT_GRACE_MS,
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
        case "leave_room":
          await this.handleLeaveRoom(ws, session, data.reason || "client_leave");
          break;
        case "deploy":
          await this.handleDeploy(ws, session, data);
          break;
        case "sync_heartbeat":
          await this.handleSyncHeartbeat(ws, session, data);
          break;
        case "resume_match":
          await this.handleResumeMatch(ws, session, data);
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
  }

  async alarm() {
    try {
      const now = Date.now();
      const rooms = await this.ctx.storage.list({ prefix: ROOM_PREFIX });
      for (const [key, room] of rooms.entries()) {
        if (!room?.suspended || !Number.isFinite(room.graceDeadline) || room.graceDeadline > now) continue;
        await this.expireSuspendedRoom(room, "resume_timeout");
        await this.ctx.storage.delete(key);
      }
      await this.scheduleNextGraceAlarm();
    } catch (error) {
      console.error(`[CX:${SERVICE_VERSION}] alarm error`, errorText(error));
      try { await this.ctx.storage.setAlarm(Date.now() + 5000); } catch (_) {}
    }
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
      rttMs: normalizedRttMs(data.rttMs),
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
      const blueResumeToken = newResumeToken();
      const redResumeToken = newResumeToken();

      const room = {
        roomId,
        createdAt: serverNow,
        startAt,
        nextServerSeq: 0,
        events: [],
        clockBaseTick: 0,
        clockBaseServerAt: startAt,
        suspended: false,
        pauseTick: null,
        graceDeadline: null,
        resumingUntil: null,
        seats: {
          blue: {
            resumeToken: blueResumeToken,
            sessionId: blueSession.sessionId,
            connected: true,
            ruleVersion: blueSession.ruleVersion ?? null,
            clientId: blueSession.clientId ?? null,
            rttMs: normalizedRttMs(blueSession.rttMs),
            lastTick: 0,
            lastCheckpointTick: 0,
            lastServerSeq: 0,
            lastSeenAt: serverNow,
          },
          red: {
            resumeToken: redResumeToken,
            sessionId: redSession.sessionId,
            connected: true,
            ruleVersion: redSession.ruleVersion ?? null,
            clientId: redSession.clientId ?? null,
            rttMs: normalizedRttMs(redSession.rttMs),
            lastTick: 0,
            lastCheckpointTick: 0,
            lastServerSeq: 0,
            lastSeenAt: serverNow,
          },
        },
      };
      await this.ctx.storage.put(roomKey(roomId), room);

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
        reconnectGraceMs: RECONNECT_GRACE_MS,
      };

      this.send(blueWs, {
        ...common,
        seat: 1,
        team: "blue",
        resumeToken: blueResumeToken,
        opponentRuleVersion: redSession.ruleVersion ?? null,
      }, "match_found_blue");

      this.send(redWs, {
        ...common,
        seat: 2,
        team: "red",
        resumeToken: redResumeToken,
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

    const key = roomKey(session.roomId);
    let room = await this.ctx.storage.get(key);
    if (!room) {
      this.sendError(ws, "room_missing", "房间已不存在，请重新匹配。");
      return;
    }
    if (room.suspended) {
      this.sendError(ws, "room_suspended", "当前房间因短时断线暂停，恢复完成前不能部署。");
      return;
    }
    if (Number.isFinite(room.resumingUntil) && Date.now() < room.resumingUntil) {
      this.sendError(ws, "resume_countdown", "房间正在恢复倒计时，暂不能部署。");
      return;
    }

    const clientSeq = data.clientSeq ?? null;
    const serverReceivedAt = Date.now();
    const relayLeadMs = roomRelayLeadMs(room);
    const applyAt = serverReceivedAt + relayLeadMs;
    const applyTick = roomApplyTick(room, applyAt);
    const serverSeq = (Number(room.nextServerSeq) || 0) + 1;

    const event = {
      op: "deploy_event",
      protocol: PROTOCOL_VERSION,
      serviceVersion: SERVICE_VERSION,
      roomId: session.roomId,
      serverSeq,
      team: session.team,
      clientSeq,
      serverReceivedAt,
      applyAt,
      applyTick,
      relayLeadMs,
      action: data.action ?? null,
    };

    room.nextServerSeq = serverSeq;
    room.events = [...(Array.isArray(room.events) ? room.events : []), event].slice(-MAX_ROOM_EVENTS);
    const seat = room.seats?.[session.team];
    if (seat) {
      seat.lastServerSeq = Math.max(Number(seat.lastServerSeq) || 0, serverSeq);
      seat.lastSeenAt = serverReceivedAt;
    }
    await this.ctx.storage.put(key, room);

    const nextSession = { ...session, lastClientSeq: clientSeq };
    this.setSession(ws, nextSession);

    this.send(ws, {
      op: "deploy_ack",
      protocol: PROTOCOL_VERSION,
      serviceVersion: SERVICE_VERSION,
      roomId: session.roomId,
      team: session.team,
      clientSeq,
      serverSeq,
      serverReceivedAt,
      applyAt,
      applyTick,
      relayLeadMs,
      serverNow: Date.now(),
    }, "deploy_ack");

    const delivered = this.broadcastRoom(session.roomId, event);

    console.log(`[CX:${SERVICE_VERSION}] deploy relayed`, {
      roomId: session.roomId,
      team: session.team,
      clientSeq,
      serverSeq,
      serverReceivedAt,
      applyAt,
      applyTick,
      relayLeadMs,
      delivered,
      action: data.action ?? null,
    });
  }

  async handleSyncHeartbeat(ws, session, data) {
    if (session.status !== "matched" || !session.roomId || !session.team) return;
    const key = roomKey(session.roomId);
    const room = await this.ctx.storage.get(key);
    if (!room?.seats?.[session.team]) return;
    const seat = room.seats[session.team];
    seat.connected = true;
    seat.sessionId = session.sessionId;
    seat.lastTick = Math.max(0, Math.floor(Number(data.tick) || 0));
    seat.lastCheckpointTick = Math.max(0, Math.floor(Number(data.checkpointTick) || 0));
    seat.lastServerSeq = Math.max(0, Math.floor(Number(data.lastServerSeq) || 0));
    const heartbeatRtt = normalizedRttMs(data.rttMs);
    if (heartbeatRtt != null) seat.rttMs = heartbeatRtt;
    seat.lastSeenAt = Date.now();
    await this.ctx.storage.put(key, room);
  }

  async handleResumeMatch(ws, session, data) {
    const roomId = String(data.roomId || "");
    const resumeToken = String(data.resumeToken || "");
    if (!roomId || !resumeToken) {
      this.sendError(ws, "bad_resume_request", "恢复请求缺少 roomId 或 resumeToken。");
      return;
    }

    const key = roomKey(roomId);
    const room = await this.ctx.storage.get(key);
    if (!room) {
      this.send(ws, { op: "resume_rejected", code: "room_missing", roomId, serverNow: Date.now() }, "resume_rejected");
      return;
    }
    if (!room.suspended || !Number.isFinite(room.graceDeadline)) {
      this.send(ws, { op: "resume_rejected", code: "room_not_suspended", roomId, serverNow: Date.now() }, "resume_rejected");
      return;
    }
    if (Date.now() > room.graceDeadline) {
      await this.expireSuspendedRoom(room, "resume_timeout");
      await this.ctx.storage.delete(key);
      await this.scheduleNextGraceAlarm();
      this.send(ws, { op: "resume_rejected", code: "resume_timeout", roomId, serverNow: Date.now() }, "resume_rejected");
      return;
    }

    let team = null;
    if (room.seats?.blue?.resumeToken === resumeToken) team = "blue";
    else if (room.seats?.red?.resumeToken === resumeToken) team = "red";
    if (!team) {
      this.send(ws, { op: "resume_rejected", code: "bad_resume_token", roomId, serverNow: Date.now() }, "resume_rejected");
      return;
    }

    const seat = room.seats[team];
    const oldSessionId = seat.sessionId;
    seat.connected = true;
    seat.sessionId = session.sessionId;
    seat.lastSeenAt = Date.now();
    seat.lastTick = Math.max(Number(seat.lastTick) || 0, Math.floor(Number(data.localTick) || 0));
    seat.lastCheckpointTick = Math.max(Number(seat.lastCheckpointTick) || 0, Math.floor(Number(data.checkpointTick) || 0));
    seat.lastServerSeq = Math.max(Number(seat.lastServerSeq) || 0, Math.floor(Number(data.lastServerSeq) || 0));
    const resumedRtt = normalizedRttMs(data.rttMs);
    if (resumedRtt != null) seat.rttMs = resumedRtt;

    const opponentTeam = team === "blue" ? "red" : "blue";
    const opponentSeat = room.seats[opponentTeam];
    const nextSession = {
      ...session,
      clientId: seat.clientId || session.clientId,
      ruleVersion: seat.ruleVersion || session.ruleVersion,
      status: "matched",
      roomId,
      team,
      peerSessionId: opponentSeat?.sessionId || null,
      startAt: room.startAt,
      resumedFromSessionId: oldSessionId || null,
    };
    this.setSession(ws, nextSession);

    const opponentEntry = this.findConnectedSeat(roomId, opponentTeam);
    if (opponentEntry) {
      const [opponentWs, opponentSession] = opponentEntry;
      this.setSession(opponentWs, { ...opponentSession, peerSessionId: session.sessionId });
    }

    await this.ctx.storage.put(key, room);

    console.log(`[CX:${SERVICE_VERSION}] resume seat rebound`, {
      roomId,
      team,
      oldSessionId,
      newSessionId: session.sessionId,
      opponentConnected: !!opponentEntry,
      pauseTick: room.pauseTick,
      graceDeadline: room.graceDeadline,
    });

    if (!opponentEntry) {
      this.send(ws, {
        op: "resume_waiting",
        protocol: PROTOCOL_VERSION,
        serviceVersion: SERVICE_VERSION,
        roomId,
        team,
        pauseTick: Math.max(0, Math.floor(Number(room.pauseTick) || 0)),
        graceDeadline: room.graceDeadline,
        serverNow: Date.now(),
      }, "resume_waiting");
      return;
    }

    await this.completeRoomResume(room);
  }

  async completeRoomResume(room) {
    const roomId = room.roomId;
    const blueEntry = this.findConnectedSeat(roomId, "blue");
    const redEntry = this.findConnectedSeat(roomId, "red");
    if (!blueEntry || !redEntry) return;

    const resumeTick = Math.max(0, Math.floor(Number(room.pauseTick) || 0));
    const resumeAt = Date.now() + RESUME_START_DELAY_MS;
    room.suspended = false;
    room.graceDeadline = null;
    room.resumingUntil = resumeAt;
    room.pauseTick = resumeTick;
    room.clockBaseTick = resumeTick;
    room.clockBaseServerAt = resumeAt;
    for (const team of ["blue", "red"]) {
      if (room.seats?.[team]) {
        room.seats[team].connected = true;
        room.seats[team].lastTick = resumeTick;
        room.seats[team].lastCheckpointTick = resumeTick;
        room.seats[team].lastSeenAt = Date.now();
      }
    }
    await this.ctx.storage.put(roomKey(roomId), room);
    await this.scheduleNextGraceAlarm();

    const payload = {
      op: "resume_ready",
      protocol: PROTOCOL_VERSION,
      serviceVersion: SERVICE_VERSION,
      roomId,
      resumeTick,
      resumeAt,
      clockBaseTick: room.clockBaseTick,
      clockBaseServerAt: room.clockBaseServerAt,
      originalStartAt: room.startAt,
      lastServerSeq: Number(room.nextServerSeq) || 0,
      events: Array.isArray(room.events) ? room.events : [],
      serverNow: Date.now(),
    };
    this.send(blueEntry[0], { ...payload, team: "blue" }, "resume_ready_blue");
    this.send(redEntry[0], { ...payload, team: "red" }, "resume_ready_red");

    console.log(`[CX:${SERVICE_VERSION}] room resume ready`, {
      roomId,
      resumeTick,
      resumeAt,
      eventCount: payload.events.length,
      lastServerSeq: payload.lastServerSeq,
    });
  }

  async handleLeaveRoom(ws, session, reason = "client_leave") {
    if (session.status !== "matched" || !session.roomId) return;
    const room = await this.ctx.storage.get(roomKey(session.roomId));
    if (room) {
      await this.terminateRoom(room, "room_closed", reason);
      await this.ctx.storage.delete(roomKey(room.roomId));
      await this.scheduleNextGraceAlarm();
    }
    const current = this.sessions.get(ws) || session;
    this.setSession(ws, this.idleSession(current));
  }

  async handleDisconnect(ws, code, reason, wasClean = false) {
    const session = this.sessions.get(ws) || ws.deserializeAttachment();
    this.sessions.delete(ws);
    if (!session) return;

    if (session.status !== "matched" || !session.roomId || !session.team) return;

    const room = await this.ctx.storage.get(roomKey(session.roomId));
    if (!room) return;

    if (code === 1000 && INTENTIONAL_CLOSE_REASONS.has(String(reason || ""))) {
      await this.terminateRoom(room, "room_closed", reason || "intentional_close");
      await this.ctx.storage.delete(roomKey(room.roomId));
      await this.scheduleNextGraceAlarm();
      return;
    }

    const seat = room.seats?.[session.team];
    if (seat) {
      seat.connected = false;
      seat.sessionId = null;
      seat.lastSeenAt = Date.now();
    }

    if (!room.suspended) {
      const blueCheckpoint = Math.max(0, Math.floor(Number(room.seats?.blue?.lastCheckpointTick) || 0));
      const redCheckpoint = Math.max(0, Math.floor(Number(room.seats?.red?.lastCheckpointTick) || 0));
      room.suspended = true;
      room.pauseTick = Math.min(blueCheckpoint, redCheckpoint);
      room.graceDeadline = Date.now() + RECONNECT_GRACE_MS;
      room.resumingUntil = null;
    }
    await this.ctx.storage.put(roomKey(room.roomId), room);
    await this.scheduleNextGraceAlarm();

    for (const [peerWs, peerSession] of this.sessions.entries()) {
      if (peerSession?.status !== "matched" || peerSession.roomId !== room.roomId) continue;
      this.send(peerWs, {
        op: "peer_reconnecting",
        protocol: PROTOCOL_VERSION,
        serviceVersion: SERVICE_VERSION,
        roomId: room.roomId,
        disconnectedTeam: session.team,
        pauseTick: Math.max(0, Math.floor(Number(room.pauseTick) || 0)),
        graceDeadline: room.graceDeadline,
        code,
        reason,
        wasClean,
        serverNow: Date.now(),
      }, "peer_reconnecting");
    }

    console.log(`[CX:${SERVICE_VERSION}] room suspended`, {
      roomId: room.roomId,
      disconnectedTeam: session.team,
      pauseTick: room.pauseTick,
      graceDeadline: room.graceDeadline,
      code,
      reason,
      wasClean,
    });
  }

  async expireSuspendedRoom(room, reason = "resume_timeout") {
    for (const [ws, session] of [...this.sessions.entries()]) {
      if (session?.status !== "matched" || session.roomId !== room.roomId) continue;
      this.send(ws, {
        op: "resume_timeout",
        protocol: PROTOCOL_VERSION,
        serviceVersion: SERVICE_VERSION,
        roomId: room.roomId,
        reason,
        serverNow: Date.now(),
      }, "resume_timeout");
      this.setSession(ws, this.idleSession(session));
    }
    console.log(`[CX:${SERVICE_VERSION}] room resume timeout`, { roomId: room.roomId, reason, serverNow: Date.now() });
  }

  async terminateRoom(room, op = "room_closed", reason = "closed") {
    for (const [ws, session] of [...this.sessions.entries()]) {
      if (session?.status !== "matched" || session.roomId !== room.roomId) continue;
      this.send(ws, {
        op,
        protocol: PROTOCOL_VERSION,
        serviceVersion: SERVICE_VERSION,
        roomId: room.roomId,
        reason,
        serverNow: Date.now(),
      }, op);
      this.setSession(ws, this.idleSession(session));
    }
  }

  idleSession(session) {
    return {
      ...session,
      status: "idle",
      queueOrder: null,
      queuedAt: null,
      roomId: null,
      team: null,
      peerSessionId: null,
      startAt: null,
      resumedFromSessionId: null,
    };
  }

  findConnectedSeat(roomId, team) {
    for (const [ws, session] of this.sessions.entries()) {
      if (session?.status === "matched" && session.roomId === roomId && session.team === team && ws.readyState === WebSocket.OPEN) return [ws, session];
    }
    return null;
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

  async scheduleNextGraceAlarm() {
    const rooms = await this.ctx.storage.list({ prefix: ROOM_PREFIX });
    let earliest = Infinity;
    for (const room of rooms.values()) {
      if (room?.suspended && Number.isFinite(room.graceDeadline)) earliest = Math.min(earliest, room.graceDeadline);
    }
    if (Number.isFinite(earliest)) await this.ctx.storage.setAlarm(earliest);
    else await this.ctx.storage.deleteAlarm();
  }
}
