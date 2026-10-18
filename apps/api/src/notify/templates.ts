import { formatDateShort, formatDuration, formatTime12h, VISIT_TYPE_LABELS } from '@haven/shared';

/**
 * SDD §15 notification text, transcribed verbatim (§15: "Every message HAVEN sends is
 * listed here ... Anything not in this table must not be sent"). Producers never write
 * their own title/body strings — they call one of these. `{placeholders}` are filled
 * from the visit (§15 intro). Push bodies never contain a guest phone number or photo
 * (§15.5).
 */

export interface PushText {
  /** Null for in-app-only messages that §15.2 gives only a body (N-CHARGE). */
  title: string | null;
  body: string;
}

type VisitTypeKey = keyof typeof VISIT_TYPE_LABELS;

/** N-WALKIN — "Guest at the gate / {guestName} wants to visit you ({type}, {duration}). Tap to approve." */
export function walkInText(p: {
  guestName: string;
  type: VisitTypeKey;
  durationMinutes: number;
}): PushText {
  return {
    title: 'Guest at the gate',
    body: `${p.guestName} wants to visit you (${VISIT_TYPE_LABELS[p.type]}, ${formatDuration(p.durationMinutes)}). Tap to approve.`,
  };
}

/** N-WALKIN-EXPIRED — "Guest request expired / {guestName}'s request at the gate wasn't answered." */
export function walkInExpiredText(p: { guestName: string }): PushText {
  return {
    title: 'Guest request expired',
    body: `${p.guestName}'s request at the gate wasn't answered.`,
  };
}

/** N-CONFIRM-LOCATION — "Confirm your guest is at the gate / {guestName}'s location couldn't be checked. Only confirm if you know they're there." */
export function confirmLocationText(p: { guestName: string }): PushText {
  return {
    title: 'Confirm your guest is at the gate',
    body: `${p.guestName}'s location couldn't be checked. Only confirm if you know they're there.`,
  };
}

/** N-ARRIVED — "{guestName} has arrived / Checked in at {time}. Tap if this isn't your guest." */
export function arrivedText(p: { guestName: string; at: Date }): PushText {
  return {
    title: `${p.guestName} has arrived`,
    body: `Checked in at ${formatTime12h(p.at)}. Tap if this isn't your guest.`,
  };
}

/**
 * N-LEFT — "{guestName} has left / Checked out at {time}." SDD F5 step 5 (normative
 * flow): "If GPS failed on exit ... the host notification says location was not
 * verified" — the one sentence appended to the catalogue body (docs/DECISIONS.md
 * DEC-012).
 */
export function leftText(p: { guestName: string; at: Date; locationVerified: boolean }): PushText {
  return {
    title: `${p.guestName} has left`,
    body: `Checked out at ${formatTime12h(p.at)}.${p.locationVerified ? '' : ' Location was not verified.'}`,
  };
}

/** N-DISPUTE — "Unknown guest reported / {hostName} (room {room}) says {guestName} is not their guest. Checked in {time}." */
export function disputeText(p: {
  hostName: string;
  room: string;
  guestName: string;
  checkedInAt: Date;
}): PushText {
  return {
    title: 'Unknown guest reported',
    body: `${p.hostName} (room ${p.room}) says ${p.guestName} is not their guest. Checked in ${formatTime12h(p.checkedInAt)}.`,
  };
}

/** N-OVERNIGHT-REQ — "Overnight request / {hostName} (room {room}) requests {nights} night(s) for {guestName}." */
export function overnightRequestText(p: {
  hostName: string;
  room: string;
  nights: number;
  guestName: string;
}): PushText {
  return {
    title: 'Overnight request',
    body: `${p.hostName} (room ${p.room}) requests ${p.nights} night(s) for ${p.guestName}.`,
  };
}

/** N-OVERNIGHT-DECIDED — approved: "Share the invite with {guestName}." / declined: "{reason}". */
export function overnightDecidedText(
  p: { decision: 'approved'; guestName: string } | { decision: 'rejected'; reason: string },
): PushText {
  if (p.decision === 'approved') {
    return { title: 'Overnight request approved', body: `Share the invite with ${p.guestName}.` };
  }
  return { title: 'Overnight request declined', body: p.reason };
}

/** N-RES-SUBMITTED — "New resident to verify / {name}, room {room}." */
export function residentSubmittedText(p: { name: string; room: string }): PushText {
  return { title: 'New resident to verify', body: `${p.name}, room ${p.room}.` };
}

/** N-RES-DECIDED — "You're verified / You can now invite guests." -- or -- "Verification not approved / {reason}". */
export function residentDecidedText(
  p: { decision: 'verified' } | { decision: 'rejected'; reason: string },
): PushText {
  if (p.decision === 'verified') {
    return { title: "You're verified", body: 'You can now invite guests.' };
  }
  return { title: 'Verification not approved', body: p.reason };
}

/**
 * N-HOST-SUSPENDED — "Guest privileges suspended / Until {date}. Your upcoming visits
 * were cancelled." A suspension with no end date has no `{date}`; the proposed wording
 * for that case is in docs/DECISIONS.md DEC-014.
 */
export function hostSuspendedText(p: { until: Date | null }): PushText {
  return {
    title: 'Guest privileges suspended',
    body: p.until
      ? `Until ${formatDateShort(p.until)}. Your upcoming visits were cancelled.`
      : 'Until the warden lifts it. Your upcoming visits were cancelled.',
  };
}

/** N-CHARGE (in-app) — "{amount} {description} -- {status}". */
export function chargeText(p: {
  amountInr: number;
  description: string;
  status: string;
}): PushText {
  return { title: null, body: `₹${p.amountInr} ${p.description} — ${p.status}` };
}

// ---------------------------------------------------------------------------
// SMS (SDD §15.3, DLT templates — ≤ 160 chars, fixed text around {#var#})
// ---------------------------------------------------------------------------

export interface SmsText {
  templateId: 'HAVEN_WALKIN' | 'HAVEN_CONFIRM_LOC' | 'HAVEN_DISPUTE';
  body: string;
}

/** HAVEN_WALKIN — "{#var#} is at the GH-8 gate to visit you. Open HAVEN to approve: {#var#}" */
export function walkInSms(p: { guestName: string; link: string }): SmsText {
  return {
    templateId: 'HAVEN_WALKIN',
    body: `${p.guestName} is at the GH-8 gate to visit you. Open HAVEN to approve: ${p.link}`,
  };
}

/** HAVEN_CONFIRM_LOC — "{#var#} needs you to confirm they're at the gate. Open HAVEN: {#var#}" */
export function confirmLocationSms(p: { guestName: string; link: string }): SmsText {
  return {
    templateId: 'HAVEN_CONFIRM_LOC',
    body: `${p.guestName} needs you to confirm they're at the gate. Open HAVEN: ${p.link}`,
  };
}

/** HAVEN_DISPUTE — "HAVEN alert: a resident reported an unknown guest at {#var#}. Open the app: {#var#}" */
export function disputeSms(p: { hostelCode: string; link: string }): SmsText {
  return {
    templateId: 'HAVEN_DISPUTE',
    body: `HAVEN alert: a resident reported an unknown guest at ${p.hostelCode}. Open the app: ${p.link}`,
  };
}

/** SDD §15.2: N-WALKIN and N-CONFIRM-LOCATION get an SMS "after 60 s if unopened". */
export const SMS_FALLBACK_DELAY_MS = 60_000;
