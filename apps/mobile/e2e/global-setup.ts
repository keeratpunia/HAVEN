import { generateTestGateToken } from './gateTestToken.js';
import { GATE_QR_VIDEO } from './playwright.config.js';
import { writeQrY4m } from './qr-fixture.js';

/** FR-22: the fake camera for the guest-scanner project shows the E2E gate's QR. */
export default function globalSetup(): void {
  const webUrl = process.env.E2E_WEB_URL ?? 'http://localhost:8081';
  writeQrY4m(GATE_QR_VIDEO, `${webUrl}/g/${generateTestGateToken({})}`);
}
