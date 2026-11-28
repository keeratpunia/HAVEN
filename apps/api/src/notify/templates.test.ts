import { describe, expect, it } from 'vitest';
import {
  arrivedText,
  confirmLocationSms,
  disputeSms,
  leftText,
  overnightDecidedText,
  walkInExpiredText,
  walkInSms,
  walkInText,
} from './templates.js';

const AT = new Date('2026-10-12T11:12:00.000Z'); // 4:42 pm IST

describe('SDD §15 notification text, verbatim', () => {
  it('N-WALKIN / N-WALKIN-EXPIRED', () => {
    expect(walkInText({ guestName: 'Simran', type: 'quick_drop', durationMinutes: 15 })).toEqual({
      title: 'Guest at the gate',
      body: 'Simran wants to visit you (Quick drop-off, 15 min). Tap to approve.',
    });
    expect(walkInExpiredText({ guestName: 'Simran' }).body).toBe(
      "Simran's request at the gate wasn't answered.",
    );
  });

  it('N-ARRIVED and N-LEFT (with F5 step 5’s unverified-exit sentence)', () => {
    expect(arrivedText({ guestName: 'Simran', at: AT })).toEqual({
      title: 'Simran has arrived',
      body: 'Checked in at 4:42 pm.',
    });
    expect(leftText({ guestName: 'Simran', at: AT, locationVerified: true })).toEqual({
      title: 'Simran has left',
      body: 'Checked out at 4:42 pm.',
    });
    expect(leftText({ guestName: 'Simran', at: AT, locationVerified: false }).body).toBe(
      'Checked out at 4:42 pm. Location was not verified.',
    );
  });

  it('N-OVERNIGHT-DECIDED both ways', () => {
    expect(overnightDecidedText({ decision: 'approved', guestName: 'Asha' })).toEqual({
      title: 'Overnight request approved',
      body: 'Share the invite with Asha.',
    });
    expect(overnightDecidedText({ decision: 'rejected', reason: 'Inspection' })).toEqual({
      title: 'Overnight request declined',
      body: 'Inspection',
    });
  });

  it('DLT SMS templates fit in 160 characters with realistic variables', () => {
    const link = 'https://app.haven.example/walk-in/3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';
    for (const sms of [
      walkInSms({ guestName: 'Simran Kaur', link }),
      confirmLocationSms({ guestName: 'Simran Kaur', link }),
      disputeSms({ hostelCode: 'GH-8', link }),
    ]) {
      expect(sms.body.length).toBeLessThanOrEqual(160);
    }
    expect(disputeSms({ hostelCode: 'GH-8', link: 'L' }).body).toBe(
      'HAVEN alert: a resident reported an unknown guest at GH-8. Open the app: L',
    );
  });
});
