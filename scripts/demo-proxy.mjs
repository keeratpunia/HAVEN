#!/usr/bin/env node
/**
 * One-off demo-rehearsal helper, not part of the product: merges the API (8080) and
 * web app (8081) behind a single local port so one cloudflared quick tunnel can expose
 * both under one origin. Two separate tunnel domains broke the refresh-token cookie
 * (SameSite=Lax correctly refuses to send it cross-site between two unrelated
 * trycloudflare.com hostnames) — in a real deployment, WEB_BASE_URL and API_BASE_URL
 * are different *subdomains of the same registrable domain* (COOKIE_DOMAIN's
 * Domain=.<domain>), which is same-site and doesn't hit this problem. A quick tunnel
 * has no shared parent domain, so this proxy exists for rehearsal only.
 *
 * Routing: anything under /v1 goes to the API (8080); everything else goes to the web
 * app (8081) — matches apps/api/src/app.ts's own '/v1' route prefix exactly.
 */
import http from 'node:http';

const PORT = Number(process.env.PROXY_PORT ?? 9000);
const API_TARGET = { host: '127.0.0.1', port: 8080 };
const WEB_TARGET = { host: '127.0.0.1', port: 8081 };

function targetFor(url) {
  return url.startsWith('/v1') ? API_TARGET : WEB_TARGET;
}

function proxyRequest(req, res) {
  const target = targetFor(req.url);
  const upstream = http.request(
    {
      host: target.host,
      port: target.port,
      path: req.url,
      method: req.method,
      headers: req.headers,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstream.on('error', (err) => {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`demo-proxy: upstream error: ${err.message}`);
  });
  req.pipe(upstream);
}

function proxyUpgrade(req, socket, head) {
  const target = targetFor(req.url);
  const upstream = http.request({
    host: target.host,
    port: target.port,
    path: req.url,
    method: req.method,
    headers: req.headers,
  });
  upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\n` +
        Object.entries(upstreamRes.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\r\n') +
        '\r\n\r\n',
    );
    upstreamSocket.write(upstreamHead);
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
  });
  upstream.on('error', () => socket.end());
  upstream.end();
}

const server = http.createServer(proxyRequest);
server.on('upgrade', proxyUpgrade);
server.listen(PORT, () => {
  console.log(`demo-proxy listening on :${PORT} (/v1 -> :8080, everything else -> :8081)`);
});
