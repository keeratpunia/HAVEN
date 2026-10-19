#!/usr/bin/env node
/**
 * Demo-only: merges the API (8080) and the web app (8081) behind one local port so one
 * cloudflared quick tunnel serves both under one origin (`pnpm demo:tunnel`). Two
 * tunnel hostnames would be two sites, and the SameSite=Lax refresh cookie would never
 * reach the API. In a real deployment the web and API hosts share a registrable domain
 * (COOKIE_DOMAIN), so this proxy exists for the demo only.
 *
 * Routing: /v1/* → API, everything else → web app (apps/api/src/app.ts's '/v1' prefix).
 *
 * Phones drop connections all the time (tab closed mid-stream, signal lost during the
 * dashboard's SSE stream): every socket error is handled and logged, never fatal — a
 * proxy crash would take the whole demo down.
 */
import http from 'node:http';

const PORT = Number(process.env.PROXY_PORT ?? 9000);
const API_TARGET = { host: '127.0.0.1', port: 8080 };
const WEB_TARGET = { host: '127.0.0.1', port: 8081 };

function targetFor(url = '/') {
  return url.startsWith('/v1') ? API_TARGET : WEB_TARGET;
}

const QUIET = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED', 'ERR_STREAM_PREMATURE_CLOSE']);
function logError(where, err) {
  if (!QUIET.has(err?.code)) console.log(`demo-proxy: ${where}: ${err?.message ?? err}`);
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
      upstreamRes.on('error', (err) => {
        logError('upstream response', err);
        res.destroy();
      });
      if (!res.headersSent) res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstream.on('error', (err) => {
    logError(`upstream ${target.port}`, err);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`demo-proxy: :${target.port} is not answering (${err.code ?? err.message})`);
    } else {
      res.destroy();
    }
  });
  // The phone went away: stop the upstream request too (ends SSE streams cleanly).
  req.on('error', (err) => {
    logError('client request', err);
    upstream.destroy();
  });
  res.on('error', (err) => logError('client response', err));
  res.on('close', () => {
    if (!res.writableEnded) upstream.destroy();
  });
  req.pipe(upstream);
}

function proxyUpgrade(req, socket, head) {
  socket.on('error', (err) => logError('client socket', err));
  const target = targetFor(req.url);
  const upstream = http.request({
    host: target.host,
    port: target.port,
    path: req.url,
    method: req.method,
    headers: req.headers,
  });
  upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    upstreamSocket.on('error', (err) => {
      logError('upstream socket', err);
      socket.destroy();
    });
    socket.on('close', () => upstreamSocket.destroy());
    upstreamSocket.on('close', () => socket.destroy());
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\n` +
        Object.entries(upstreamRes.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\r\n') +
        '\r\n\r\n',
    );
    upstreamSocket.write(upstreamHead);
    if (head?.length) upstreamSocket.write(head);
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
  });
  upstream.on('error', (err) => {
    logError(`upstream upgrade ${target.port}`, err);
    socket.destroy();
  });
  upstream.end();
}

const server = http.createServer(proxyRequest);
server.on('upgrade', proxyUpgrade);
server.on('clientError', (err, socket) => {
  logError('client', err);
  socket.destroy();
});
// Last line of defence for the live demo: log, keep serving.
process.on('uncaughtException', (err) => logError('uncaught', err));
server.listen(PORT, () => {
  console.log(`demo-proxy listening on :${PORT} (/v1 -> :8080, everything else -> :8081)`);
});
