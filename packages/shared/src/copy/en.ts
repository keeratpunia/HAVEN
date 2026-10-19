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
  // Not in SDD §13.6: proposed in docs/DECISIONS.md DEC-013 for the accepted deviation
  // where a first-time guest who signs up mid-scan must scan the gate QR once more.
  GATE_RESCAN_AFTER_SIGN_IN: {
    title: "You're signed in",
    body: 'Scan the QR on the gate screen once more to continue. Your details are saved.',
  },
  GATE_TOKEN_INVALID: {
    title: "We can't read this code",
    body: "Make sure you're scanning the HAVEN screen at the hostel gate.",
  },
  OUT_OF_GEOFENCE: {
    title: "You're not at the gate yet",
    body: 'We need you to be at the hostel gate to check in. Walk closer and try again.',
  },
  // FR-27 / F3: location permission denied. PROPOSED copy (the SDD gives the path, not
  // the words), DEC-022.
  location_denied: {
    title: 'Location is turned off for HAVEN',
    body: "Allow location for this site and try again, or ask your host to confirm you're at the gate.",
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

  // ---- Privacy notice and consent (SDD §16.3, FR-02, R-03) ----
  // §16.3 says what the notice covers (purpose, data, who sees it, retention, how to
  // delete, contact) but gives no wording. PROPOSED copy, docs/DECISIONS.md DEC-020.
  // Changing any PRIVACY_* text means bumping CONSENT_VERSION (packages/shared/src/consent.ts).
  PRIVACY_SUMMARY: {
    title: 'Your privacy',
    body: 'HAVEN uses your name, phone, gender and photos only to let you into the hostel and keep a record of your visits. Your host and the warden can see them. Photos are kept up to 180 days and your details for 365 days after your last visit. You can delete your account at any time.',
  },
  PRIVACY_CONSENT_LABEL: {
    title: 'I agree to the privacy notice',
    body: 'Read the full privacy notice',
  },
  PRIVACY_PURPOSE: {
    title: 'Why we collect it',
    body: 'Only to manage entry to the hostel: to check you are expected, to let your host recognise you, and to keep a record of who came in and left. Nothing is used for advertising or shared with third parties.',
  },
  PRIVACY_DATA: {
    title: 'What we collect',
    body: 'Guests: phone number, name, gender, a profile photo, a live photo each time you check in or out, and where you were when you scanned the gate (only to check you are at the gate, never tracked). Residents: name, Google email, phone, room, a hostel ID card photo and a selfie.',
  },
  PRIVACY_WHO: {
    title: 'Who can see it',
    body: "Your host and the warden. The warden's office sees charges only, without phone numbers or photos. Every view of photos and every export is logged.",
  },
  PRIVACY_RETENTION: {
    title: 'How long we keep it',
    body: "Gate photos: 180 days. Profile photo and your name and phone: 365 days after your last visit. Location from a scan: 1 day. A resident's ID card photo: deleted as soon as the warden decides.",
  },
  PRIVACY_DELETE: {
    title: 'How to delete it',
    body: 'Use Delete my account in My visits (guests) or Profile (residents). We sign you out at once and delete your data within 7 days.',
  },
  PRIVACY_CONTACT: {
    title: 'Questions',
    body: "Contact the warden's office of your hostel.",
  },

  // ---- Account deletion (FR-09, SDD §16.6) ----
  // The SDD names only the button, "Delete my account" (§16.6). Everything below is not
  // in §13.6: proposed in docs/DECISIONS.md DEC-015 and APPROVED by the team (DEC-016).
  ACCOUNT_DELETE_CONFIRM_GUEST: {
    title: 'Delete your account?',
    body: "You'll be signed out everywhere. Within 7 days we delete your photos and remove your name and phone number. Your hosts keep a record of past visits, without your details.",
  },
  ACCOUNT_DELETE_CONFIRM_RESIDENT: {
    title: 'Delete your account?',
    body: "You'll be signed out everywhere. Within 7 days we delete your photos and remove your name, email and phone number, and cancel guest visits that haven't started. Records of past visits stay, without your details.",
  },
  ACCOUNT_DELETION_REQUESTED: {
    title: 'Deletion requested',
    body: "You've been signed out. Your account will be deleted within 7 days.",
  },
  ACCOUNT_DELETION_WAITS_INSIDE: {
    title: 'Deletion requested',
    body: "You're checked in right now, so we'll delete your account after this visit ends. You've been signed out — sign in again only to check out at the gate.",
  },
  ACCOUNT_DELETION_WAITS_UPCOMING: {
    title: 'Deletion requested',
    body: "You have a visit in the next 24 hours, so we'll delete your account after it ends. You've been signed out.",
  },
  ACCOUNT_DELETION_UNPAID: {
    title: 'Clear your charges first',
    body: "You owe ₹{amount}. You can delete your account once the warden's office marks it paid.",
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
