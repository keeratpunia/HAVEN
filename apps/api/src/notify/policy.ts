import { definePolicy } from '../auth/policy.js';
import type { Principal } from '../auth/principal.js';

/** `authorize()` rules for the notifications endpoints (SDD §3.4, §12.4). */
export interface NotificationOwnerResource {
  recipientType: 'user' | 'visitor' | 'phone';
  recipientId: string | null;
}

function isRecipientUser(principal: Principal | null, r: NotificationOwnerResource): boolean {
  return (
    principal?.type === 'user' && r.recipientType === 'user' && r.recipientId === principal.userId
  );
}

let registered = false;

export function registerNotificationPolicies(): void {
  if (registered) return;
  registered = true;
  // SDD §12.4: push tokens, the in-app list and "opened" are User-only, own rows only.
  definePolicy<NotificationOwnerResource>('notifications.read', isRecipientUser);
  definePolicy<NotificationOwnerResource>('notifications.open', isRecipientUser);
  definePolicy<NotificationOwnerResource>('push_tokens.register', isRecipientUser);
}

export function __resetNotificationPoliciesForTests(): void {
  registered = false;
}
