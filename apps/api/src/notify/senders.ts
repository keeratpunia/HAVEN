import { Expo, type ExpoPushMessage, type ExpoPushTicket } from 'expo-server-sdk';
import { renderDlt, type DltTemplateId } from './dlt.js';

/**
 * Delivery adapters behind the notification worker (SDD §9.7): push via
 * `expo-server-sdk` (chunked), SMS via `SmsProvider.send(to, templateId, vars)` with
 * `ConsoleSmsProvider` for dev and tests. No credentials live in code: Expo's optional
 * access token comes from the environment, and a real SMS provider is not wired in this
 * prototype (docs/DECISIONS.md DEC-015). Tests inject fakes for both.
 */

export interface PushMessage {
  to: string;
  title: string | null;
  body: string;
  data: Record<string, unknown>;
  channelId: string;
  priority: 'high' | 'default';
}

export type PushTicket =
  { status: 'ok'; id: string } | { status: 'error'; message: string; deviceNotRegistered: boolean };

export type PushReceipt =
  { status: 'ok' } | { status: 'error'; message: string; deviceNotRegistered: boolean };

export interface PushSender {
  /** One ticket per message, in order. */
  send(messages: PushMessage[]): Promise<PushTicket[]>;
  /** Receipts by ticket id; ids Expo doesn't know yet are simply absent. */
  getReceipts(ticketIds: string[]): Promise<Record<string, PushReceipt>>;
}

export interface SmsProvider {
  /** Sends one registered DLT template (§15.3) with its variables, in order. */
  send(to: string, templateId: DltTemplateId, vars: readonly string[]): Promise<{ ref: string }>;
}

export class ExpoPushSender implements PushSender {
  private readonly expo: Expo;

  constructor(accessToken?: string) {
    this.expo = new Expo(accessToken ? { accessToken } : {});
  }

  async send(messages: PushMessage[]): Promise<PushTicket[]> {
    const tickets: PushTicket[] = [];
    const valid: { index: number; message: ExpoPushMessage }[] = [];
    messages.forEach((m, index) => {
      if (!Expo.isExpoPushToken(m.to)) {
        tickets[index] = {
          status: 'error',
          message: 'Not an Expo push token',
          deviceNotRegistered: true,
        };
        return;
      }
      valid.push({
        index,
        message: {
          to: m.to,
          title: m.title ?? undefined,
          body: m.body,
          data: m.data,
          channelId: m.channelId,
          priority: m.priority,
          sound: 'default',
        },
      });
    });

    let offset = 0;
    for (const chunk of this.expo.chunkPushNotifications(valid.map((v) => v.message))) {
      const chunkTickets: ExpoPushTicket[] = await this.expo.sendPushNotificationsAsync(chunk);
      chunkTickets.forEach((ticket, i) => {
        const target = valid[offset + i];
        if (!target) return;
        tickets[target.index] =
          ticket.status === 'ok'
            ? { status: 'ok', id: ticket.id }
            : {
                status: 'error',
                message: ticket.message,
                deviceNotRegistered: ticket.details?.error === 'DeviceNotRegistered',
              };
      });
      offset += chunk.length;
    }
    return tickets;
  }

  async getReceipts(ticketIds: string[]): Promise<Record<string, PushReceipt>> {
    const out: Record<string, PushReceipt> = {};
    for (const chunk of this.expo.chunkPushNotificationReceiptIds(ticketIds)) {
      const receipts = await this.expo.getPushNotificationReceiptsAsync(chunk);
      for (const [id, r] of Object.entries(receipts)) {
        out[id] =
          r.status === 'ok'
            ? { status: 'ok' }
            : {
                status: 'error',
                message: r.message,
                deviceNotRegistered: r.details?.error === 'DeviceNotRegistered',
              };
      }
    }
    return out;
  }
}

/** Dev/test SMS delivery: logs instead of sending (§15.3: "Until approved, use SMS_PROVIDER=console"). */
export class ConsoleSmsProvider implements SmsProvider {
  constructor(private readonly appEnv: 'local' | 'staging' | 'production') {}

  async send(
    to: string,
    templateId: DltTemplateId,
    vars: readonly string[],
  ): Promise<{ ref: string }> {
    if (this.appEnv === 'production') {
      throw new Error('SMS_PROVIDER=console must never be used in production');
    }
    const text = renderDlt(templateId, vars);
    // Phones are logged masked only (CLAUDE.md §4).
    const masked = `${to.slice(0, 3)}•••••${to.slice(-5)}`;
    // eslint-disable-next-line no-console -- intentional dev-only SMS delivery
    console.log(`[sms:dev] ${masked} ${templateId}: ${text}`);
    return { ref: `console-${Date.now()}` };
  }
}
