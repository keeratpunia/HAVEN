import { RESIDENT_SCREENS, type VisitDTO } from '@haven/shared';

/** Which screen a visit card opens — decided from the API's own status/allowedActions. */
export function screenForVisit(
  v: Pick<VisitDTO, 'id' | 'status' | 'allowedActions' | 'awaitingHostConfirmation'>,
): string {
  if (v.status === 'pending_host') return RESIDENT_SCREENS.walkIn(v.id);
  if (v.awaitingHostConfirmation) return RESIDENT_SCREENS.arrival(v.id);
  return RESIDENT_SCREENS.visit(v.id);
}

/** Needs the host now: a walk-in at the gate or an arrival to confirm (R-05 "pending requests (top, amber)"). */
export function needsHost(v: Pick<VisitDTO, 'status' | 'awaitingHostConfirmation'>): boolean {
  return v.status === 'pending_host' || v.awaitingHostConfirmation;
}
