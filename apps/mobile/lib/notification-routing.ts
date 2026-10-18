import { isPushData, safeScreen } from '@haven/shared';

/**
 * SDD §13.7 "Push tap behaviour: opens the exact screen (R-08 for walk-ins, R-09 for
 * arrivals, W-05 for disputes) and calls /notifications/{id}/opened". Pure so it can be
 * unit-tested; the screen comes from the API-stamped `screen` field (§15.1) and is
 * passed through `safeScreen`, so a malformed payload can only ever land on home.
 */
export interface TapDeps {
  navigate: (path: string) => void;
  markOpened: (notificationId: string) => Promise<unknown>;
}

export async function handleNotificationTap(data: unknown, deps: TapDeps): Promise<string> {
  if (!isPushData(data)) {
    deps.navigate(safeScreen(null));
    return safeScreen(null);
  }
  const path = safeScreen(data.screen);
  deps.navigate(path);
  // Opening cancels the SMS fallback (SDD §9.7); a failure must not block navigation.
  await deps.markOpened(data.notificationId).catch(() => undefined);
  return path;
}
