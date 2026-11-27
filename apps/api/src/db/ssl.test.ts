import { X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { pgConnectionOptions, SUPABASE_ROOT_CA_2021 } from './ssl.js';

/** DEC-028: verified TLS to Supabase's pooler with the pinned Supabase root CA. */
describe('database TLS options', () => {
  it('pins the Supabase Root 2021 CA (checked against the live Mumbai pooler, 2026-11-27)', () => {
    const cert = new X509Certificate(SUPABASE_ROOT_CA_2021);
    expect(cert.subject).toContain('CN=Supabase Root 2021 CA');
    expect(cert.fingerprint256).toBe(
      '80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA',
    );
  });

  it('uses no TLS for a local database', () => {
    for (const url of [
      'postgres://u:p@localhost:5432/db',
      'postgres://u:p@127.0.0.1:54625/haven_demo',
    ]) {
      expect(pgConnectionOptions(url)).toEqual({ connectionString: url });
    }
  });

  it('verifies a Supabase pooler against the pinned CA and drops sslmode from the URL', () => {
    const opts = pgConnectionOptions(
      'postgres://haven_api.abc:pw@aws-1-ap-south-1.pooler.supabase.com:6543/postgres?sslmode=no-verify',
    );
    expect(opts.connectionString).not.toContain('sslmode');
    expect(opts.ssl).toEqual({
      rejectUnauthorized: true,
      servername: 'aws-1-ap-south-1.pooler.supabase.com',
      ca: SUPABASE_ROOT_CA_2021,
    });
  });

  it('uses DATABASE_CA_CERT when given, and the system trust store for other hosts', () => {
    expect(
      pgConnectionOptions('postgres://u:p@db.abc.supabase.co:5432/postgres', 'PEM').ssl,
    ).toEqual({ rejectUnauthorized: true, servername: 'db.abc.supabase.co', ca: 'PEM' });
    expect(pgConnectionOptions('postgres://u:p@db.example.com:5432/x').ssl).toEqual({
      rejectUnauthorized: true,
      servername: 'db.example.com',
    });
  });
});
