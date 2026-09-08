const SERVICE_VERSION = "S0005";
const PROTOCOL_VERSION = 1;

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
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({
        ok: true,
        service: "cx-battle-match-relay",
        serviceVersion: SERVICE_VERSION,
        protocol: PROTOCOL_VERSION,
        mode: "MIN_WS_TEST",
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

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      server.accept();

      server.send(JSON.stringify({
        op: "connected",
        protocol: PROTOCOL_VERSION,
        serviceVersion: SERVICE_VERSION,
        mode: "MIN_WS_TEST",
        serverNow: Date.now(),
      }));

      server.addEventListener("message", (event) => {
        try {
          server.send(typeof event.data === "string" ? event.data : "binary");
        } catch (_) {}
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    return json({
      service: "cx-battle-match-relay",
      serviceVersion: SERVICE_VERSION,
      protocol: PROTOCOL_VERSION,
      mode: "MIN_WS_TEST",
      endpoints: { health: "/health", websocket: "/ws" },
    });
  },
};
