/**
 * The server's clock, as seen from this device (SDD §9.13: "The server clock decides
 * everything"). Every API response carries `X-Server-Time`; we keep the offset from the
 * device clock so screens that pre-check hostel rules locally (the resident invite and
 * overnight forms) judge "now" the way the server will — a phone whose clock is wrong
 * (E-02), or a demo whose clock was moved, doesn't disable a valid request.
 */
let offsetMs = 0;

export function noteServerTime(header: string | null | undefined, deviceNowMs = Date.now()): void {
  if (!header) return;
  const serverMs = Date.parse(header);
  if (!Number.isNaN(serverMs)) offsetMs = serverMs - deviceNowMs;
}

export function serverNow(deviceNowMs = Date.now()): Date {
  return new Date(deviceNowMs + offsetMs);
}
