/**
 * The gate screen's QR encodes `<WEB_BASE_URL>/g/<token>` (SDD §9.1, F1 step 7). An
 * in-app scanner (FR-22 on the guest home, R-12 host-assisted entry) reads only the
 * token from it and stays inside the app: it never opens the scanned URL, so a QR
 * pointing elsewhere can't send the guest to another site. The server verifies the
 * token itself (§9.1).
 */
const GATE_TOKEN = /^[A-Z0-9]{6}\.\d{1,12}\.[0-9A-HJKMNP-TV-Z]{16}$/;

export function gateTokenFromQr(scanned: string): string | null {
  const text = scanned.trim();
  if (GATE_TOKEN.test(text)) return text;
  const match = /\/g\/([^/?#\s]+)\/?(?:[?#].*)?$/.exec(text);
  const token = match?.[1] ? decodeURIComponent(match[1]) : null;
  return token && GATE_TOKEN.test(token) ? token : null;
}
