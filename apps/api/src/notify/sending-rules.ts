/**
 * SDD §15.5: "Never put a guest's phone number, or any photo, in a push or SMS body."
 * Every template is written so this can't happen, but names are user input (a guest can
 * type digits into their name) and SQL jobs build text too, so the worker checks the
 * final text once more and refuses to deliver anything that looks like either.
 */

// An Indian mobile number: optional +91 / 91 prefix, then 10 digits starting 6-9, not
// part of a longer run of digits (so ids and timestamps don't match).
const PHONE = /(?<!\d)(?:\+?91[\s-]?)?[6-9]\d{9}(?!\d)/;
// A photo: our media route, an image file name, or a signed-URL query.
const PHOTO = /\/media\/|\.(?:jpe?g|png|webp|heic)\b|[?&](?:sig|signature|token|expires)=/i;

/** Null when the text is safe to send; otherwise why it isn't. */
export function personalDataIn(text: string | null): string | null {
  if (!text) return null;
  if (PHONE.test(text)) return 'contains a phone number';
  if (PHOTO.test(text)) return 'contains a photo link';
  return null;
}
