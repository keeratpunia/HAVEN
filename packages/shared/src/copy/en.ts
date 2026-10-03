/**
 * Code-to-message mapping (SDD §13.6): "Error codes and copy from 12.2 and 13.6 used;
 * no new user-facing strings outside [this]." Keys are ready for Hindi/Punjabi later
 * (SDD §13.6) — this file is English only, keyed by error/rule code or named "moment."
 *
 * Transcribed verbatim from the SDD's own copy table — do not paraphrase an entry
 * without updating the SDD in the same change (CLAUDE.md §1.2/§1.3).
 */
export interface CopyEntry {
  title: string;
  body: string;
}

export const EN_COPY: Record<string, CopyEntry> = {
  GATE_TOKEN_EXPIRED: {
    title: 'That code has changed',
    body: 'Scan the QR on the gate screen again. It changes every 10 seconds.',
  },
  GATE_TOKEN_INVALID: {
    title: "We can't read this code",
    body: "Make sure you're scanning the HAVEN screen at the hostel gate.",
  },
  OUT_OF_GEOFENCE: {
    title: "You're not at the gate yet",
    body: 'We need you to be at the hostel gate to check in. Walk closer and try again.',
  },
  low_accuracy: {
    title: "We can't pin your location",
    body: 'Turn on GPS / Location, step out from under a roof, and try again.',
  },
  AFTER_ENTRY_CUTOFF: {
    title: 'Entry has closed for today',
    body: 'Guests can enter until 8:00 pm. Overnight guests approved by the warden can enter until 10:00 pm.',
  },
  AFTER_HARD_CUTOFF: {
    title: 'The hostel is closed to guests',
    body: 'No guests can enter after 10:00 pm.',
  },
  TOO_EARLY: {
    title: "You're early",
    body: 'Your visit starts at 4:00 pm. You can check in from 3:30 pm.',
  },
  WINDOW_ENDED: {
    title: 'This visit has ended',
    body: 'Ask your host to invite you again.',
  },
  VISITOR_BANNED: {
    title: "You can't enter this hostel",
    body: "Please contact the warden's office.",
  },
  HOST_NOT_VERIFIED: {
    title: "Your host can't have guests right now",
    body: 'Please contact your host.',
  },
  HOST_SUSPENDED: {
    title: "Your host can't have guests right now",
    body: 'Please contact your host.',
  },
  ALREADY_INSIDE: {
    title: "You're already checked in",
    body: 'Check out first from your current visit.',
  },
  WALK_IN_REJECTED: {
    title: "{hostFirstName} couldn't approve this visit",
    body: 'Please contact your host directly.',
  },
  WALK_IN_EXPIRED: {
    title: 'No answer from {hostFirstName}',
    body: 'Try calling her, then request again.',
  },
  HOST_CONFIRM_PATH: {
    title: 'Ask {hostFirstName} to confirm {subject} here',
    body: "She'll get your photo. Only she can let you in without location.",
  },
  CHECK_IN_SUCCESS: {
    title: "You're checked in",
    body: 'Visiting {hostFirstName} (room {room}) until {endTime}. Scan the gate QR again when you leave.',
  },
  ZONE_NOTICE: {
    title: "Visitors' Room only",
    body: 'Hostel rules allow you only in the Visitors’ Room.',
  },
  INTERNAL_5XX_GATE: {
    title: 'Something went wrong on our side',
    body: "It's not you — try again in a moment.",
  },
};

/** Fills `{placeholder}` tokens in a copy entry's title/body (SDD §15: "{placeholders} are filled from the visit"). */
export function fillCopy(entry: CopyEntry, values: Record<string, string>): CopyEntry {
  const fill = (s: string) =>
    s.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? `{${key}}`);
  return { title: fill(entry.title), body: fill(entry.body) };
}

/** Looks up copy for a code; falls back to a generic, still-actionable message (SDD §13.1 principle 5: "never a dead end"). */
export function copyFor(code: string): CopyEntry {
  return (
    EN_COPY[code] ?? {
      title: 'Something went wrong',
      body: 'Please try again. If it keeps happening, ask your host or the warden.',
    }
  );
}
