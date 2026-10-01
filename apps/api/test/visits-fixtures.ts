import type { Kysely } from 'kysely';
import type { Database } from '../src/db/index.js';

let counter = 0;
function unique(): number {
  counter += 1;
  return counter;
}

export async function makeHostel(db: Kysely<Database>, genderServed: 'male' | 'female' = 'female') {
  const row = await db
    .insertInto('haven.hostels')
    .values({ code: `VH${unique()}`, name: 'Visits Test Hostel', gender_served: genderServed })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function makeRoom(db: Kysely<Database>, hostelId: string) {
  const row = await db
    .insertInto('haven.rooms')
    .values({ hostel_id: hostelId, number: `R${unique()}` })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function makeVerifiedHost(db: Kysely<Database>, hostelId: string) {
  const roomId = await makeRoom(db, hostelId);
  const user = await db
    .insertInto('haven.users')
    .values({
      google_sub: `host-sub-${unique()}`,
      email: `host-${unique()}@haven.test`,
      full_name: 'Test Host',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('haven.residents')
    .values({
      user_id: user.id,
      hostel_id: hostelId,
      claimed_room: 'R1',
      room_id: roomId,
      status: 'verified',
    })
    .execute();
  return user.id;
}

export async function makeWarden(db: Kysely<Database>, hostelId: string) {
  const user = await db
    .insertInto('haven.users')
    .values({
      google_sub: `warden-sub-${unique()}`,
      email: `warden-${unique()}@haven.test`,
      full_name: 'Test Warden',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('haven.role_assignments')
    .values({ user_id: user.id, hostel_id: hostelId, role: 'warden' })
    .execute();
  return user.id;
}

export async function makeVisitor(
  db: Kysely<Database>,
  phone?: string,
  gender: 'female' | 'male' | 'undisclosed' = 'female',
) {
  const row = await db
    .insertInto('haven.visitors')
    .values({
      phone: phone ?? `+9198765${String(10000 + unique()).padStart(5, '0')}`,
      full_name: 'Test Guest',
      gender,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function makeGate(db: Kysely<Database>, hostelId: string) {
  const row = await db
    .insertInto('haven.gates')
    .values({
      hostel_id: hostelId,
      code: `G${String(unique()).padStart(5, '0')}`,
      secret_enc: Buffer.from('test-secret-not-real'),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}
