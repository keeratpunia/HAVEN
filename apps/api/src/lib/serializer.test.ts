import { describe, expect, it } from 'vitest';
import { omitFields, type Serializer } from './serializer.js';

describe('omitFields', () => {
  it('removes the named keys and keeps the rest', () => {
    const row = { id: '1', name: 'Priya', phone: '+919812345678', photoUrl: 'https://...' };
    const result = omitFields(row, ['phone', 'photoUrl']);
    expect(result).toEqual({ id: '1', name: 'Priya' });
  });

  it('does not mutate the original object', () => {
    const row = { id: '1', phone: '+919812345678' };
    omitFields(row, ['phone']);
    expect(row).toEqual({ id: '1', phone: '+919812345678' });
  });

  it('is a no-op when given an empty key list', () => {
    const row = { id: '1', phone: '+919812345678' };
    expect(omitFields(row, [])).toEqual(row);
  });

  it('demonstrates the SDD §3.4 office-serializer pattern: stripping phone and photo fields by role', () => {
    type Row = { id: string; name: string; phone: string; photoUrl: string };
    const forOffice: Serializer<Row, 'office' | 'warden', Partial<Row>> = (row, role) =>
      role === 'office' ? omitFields(row, ['phone', 'photoUrl']) : row;

    const row: Row = { id: '1', name: 'Priya', phone: '+919812345678', photoUrl: 'https://...' };
    expect(forOffice(row, 'office')).toEqual({ id: '1', name: 'Priya' });
    expect(forOffice(row, 'warden')).toEqual(row);
  });
});
