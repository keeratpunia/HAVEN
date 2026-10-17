import { Expo, type ExpoPushMessage, type ExpoPushTicket } from 'expo-server-sdk';

/**
 * Delivery adapters behind the notification worker (SDD §9.7): push via
 * `expo-server-sdk` (chunked), SMS via the `SmsProvider.send(to, templateId, vars)`
 * interface with `ConsoleSmsProvider` for dev. Tests inject fakes for both.
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

export interface PushSender {
  /** One ticket per message, in order. */
  send(messages: PushMessage[]): Promise<PushTicket[]>;
}

export interface SmsSender {
  send(to: string, templateId: string, body: string): Promise<{ ref: string }>;
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
}

/** Dev-only SMS delivery: prints instead of sending (SDD §15.3: "Until approved, use SMS_PROVIDER=console"). */
export class ConsoleSmsSender implements SmsSender {
  constructor(private readonly appEnv: 'local' | 'staging' | 'production') {}

  async send(to: string, templateId: string, body: string): Promise<{ ref: string }> {
    if (this.appEnv === 'production') {
      throw new Error('SMS_PROVIDER=console must never be used in production');
    }
    // Phones are logged masked only (CLAUDE.md §4).
    const masked = `${to.slice(0, 3)}•••••${to.slice(-5)}`;
    // eslint-disable-next-line no-console -- intentional dev-only SMS delivery
    console.log(`[sms:dev] ${masked} ${templateId}: ${body}`);
    return { ref: `console-${Date.now()}` };
  }
}
