/**
 * SDD §15.3 SMS templates, verbatim. Indian commercial SMS must use a template
 * registered on the DLT platform; the operator rejects any message whose fixed text
 * differs, so these strings are the only SMS HAVEN can send (§15: "Anything not in this
 * table must not be sent"). `{#var#}` is the DLT variable syntax.
 */
export const DLT_TEMPLATES = {
  HAVEN_OTP: "{#var#} is your HAVEN code. It expires in 5 minutes. Don't share it with anyone.",
  HAVEN_WALKIN: '{#var#} is at the GH-8 gate to visit you. Open HAVEN to approve: {#var#}',
  HAVEN_CONFIRM_LOC: "{#var#} needs you to confirm they're at the gate. Open HAVEN: {#var#}",
  HAVEN_OVERSTAY: 'Your HAVEN visit ended at {#var#}. Please check out at the gate now.',
  HAVEN_DISPUTE:
    'HAVEN alert: a resident reported an unknown guest at {#var#}. Open the app: {#var#}',
} as const;

export type DltTemplateId = keyof typeof DLT_TEMPLATES;

const VAR = '{#var#}';

export function isDltTemplateId(id: string): id is DltTemplateId {
  return Object.prototype.hasOwnProperty.call(DLT_TEMPLATES, id);
}

/** Fills the template's variables in order. Throws if the count doesn't match. */
export function renderDlt(templateId: DltTemplateId, vars: readonly string[]): string {
  const parts = DLT_TEMPLATES[templateId].split(VAR);
  if (parts.length - 1 !== vars.length) {
    throw new Error(`${templateId} takes ${parts.length - 1} variable(s), got ${vars.length}`);
  }
  return parts.reduce((out, part, i) => out + part + (vars[i] ?? ''), '');
}
