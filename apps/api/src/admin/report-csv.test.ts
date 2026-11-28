import { describe, expect, it } from 'vitest';
import { reportCsvRow, type ReportCsvSource } from './visit-routes.js';

/** W-12 CSV in the hostel's time and words (DEC-032). */
const base: ReportCsvSource = {
  code: 'VAB12CD',
  type: 'day',
  status: 'completed',
  guest_name: 'Ananya Rao',
  invited_name: null,
  host_name: 'Priya Sharma',
  room_number: '101',
  claimed_room: '101',
  // 09:00–12:00 IST on 28 Nov 2026
  window_start: new Date('2026-11-28T03:30:00Z'),
  window_end: new Date('2026-11-28T06:30:00Z'),
  first_entry_at: new Date('2026-11-28T03:40:00Z'),
  last_exit_at: new Date('2026-11-28T08:40:00Z'),
  closed_at: new Date('2026-11-28T08:40:00Z'),
  overstay_since: new Date('2026-11-28T06:45:00Z'),
  host_disputed_at: null,
  location_unverified: false,
  close_reason: 'checked_out',
};
const col = (row: string[], name: string) =>
  row[
    [
      'Code',
      'Date',
      'Type',
      'Status',
      'Guest',
      'Host',
      'Room',
      'Expected from',
      'Expected until',
      'Checked in',
      'Checked out',
      'Overstay',
      'Not my guest',
      'Location',
      'How it ended',
    ].indexOf(name)
  ];

describe('report CSV rows', () => {
  it('uses Indian time and plain words, and says when an overstaying guest left', () => {
    const row = reportCsvRow(base, 'Asia/Kolkata');
    expect(col(row, 'Date')).toBe('28 Nov 2026');
    expect(col(row, 'Type')).toBe('Day visit');
    expect(col(row, 'Status')).toBe('Completed');
    expect(col(row, 'Expected from')).toBe('9:00 am');
    expect(col(row, 'Checked in')).toBe('28 Nov 2026, 9:10 am');
    expect(col(row, 'Checked out')).toBe('28 Nov 2026, 2:10 pm');
    expect(col(row, 'Overstay')).toBe('Yes, left 28 Nov 2026, 2:10 pm');
    expect(col(row, 'Location')).toBe('Verified');
    expect(col(row, 'How it ended')).toBe('Checked out at the gate');
    expect(row.join(' ')).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('says an overstaying guest is still inside, and leaves Overstay empty otherwise', () => {
    const inside = reportCsvRow(
      { ...base, status: 'inside', last_exit_at: null, closed_at: null, close_reason: null },
      'Asia/Kolkata',
    );
    expect(col(inside, 'Overstay')).toBe(
      'Yes, still inside (overstaying since 28 Nov 2026, 12:15 pm)',
    );
    expect(col(inside, 'Checked out')).toBe('');
    expect(col(inside, 'How it ended')).toBe('');
    const onTime = reportCsvRow({ ...base, overstay_since: null }, 'Asia/Kolkata');
    expect(col(onTime, 'Overstay')).toBe('');
  });

  it('names a guest who never came, and a dispute', () => {
    const never = reportCsvRow(
      {
        ...base,
        status: 'expired',
        guest_name: null,
        invited_name: 'Sneha Pillai',
        first_entry_at: null,
        last_exit_at: null,
        overstay_since: null,
        close_reason: 'window_ended',
        host_disputed_at: new Date('2026-11-28T04:00:00Z'),
      },
      'Asia/Kolkata',
    );
    expect(col(never, 'Guest')).toBe('Sneha Pillai');
    expect(col(never, 'Status')).toBe('Expired');
    expect(col(never, 'How it ended')).toBe("Guest didn't arrive");
    expect(col(never, 'Location')).toBe('');
    expect(col(never, 'Not my guest')).toBe('Reported');
  });
});
