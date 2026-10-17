import { describe, expect, it } from 'vitest';
import {
  displayName,
  formatDateShort,
  formatDuration,
  formatTime12h,
  maskPhone,
} from './format.js';

describe('shared display formats (SDD §13.1)', () => {
  it('formats IST 12-hour times like "4:42 pm"', () => {
    expect(formatTime12h('2026-10-12T11:12:00.000Z')).toBe('4:42 pm');
    expect(formatTime12h('2026-10-12T03:30:00.000Z')).toBe('9:00 am');
  });

  it('formats dates like "Sun, 12 Oct"', () => {
    expect(formatDateShort('2026-10-12T06:00:00.000Z')).toBe('Mon, 12 Oct');
  });

  it('shows hosts as first name + last initial (FR-25)', () => {
    expect(displayName('Priya Sharma')).toBe('Priya S.');
    expect(displayName('Priya Rani Sharma')).toBe('Priya S.');
    expect(displayName('Priya')).toBe('Priya');
  });

  it('formats walk-in durations', () => {
    expect(formatDuration(15)).toBe('15 min');
    expect(formatDuration(60)).toBe('1 h');
    expect(formatDuration(150)).toBe('2 h 30 min');
  });

  it('masks guest phones', () => {
    expect(maskPhone('+919876543210')).toBe('+91•••••43210');
  });
});
