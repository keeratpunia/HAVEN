import { noteServerTime, serverNow } from '../lib/server-time';

/** SDD §9.13 / E-02: local rule pre-checks use the server's clock, not the device's. */
describe('serverNow', () => {
  it('follows the offset from the last X-Server-Time header', () => {
    const device = Date.parse('2026-10-19T15:30:00.000Z'); // 21:00 IST on the device
    noteServerTime('2026-10-19T07:30:00.000Z', device); // the server says 13:00 IST
    expect(serverNow(device + 60_000).toISOString()).toBe('2026-10-19T07:31:00.000Z');
  });

  it('ignores a missing or unreadable header', () => {
    const device = Date.parse('2026-10-19T15:30:00.000Z');
    noteServerTime('2026-10-19T07:30:00.000Z', device);
    noteServerTime(null, device);
    noteServerTime('not a date', device);
    expect(serverNow(device).toISOString()).toBe('2026-10-19T07:30:00.000Z');
  });
});
