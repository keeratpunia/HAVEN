import { useCallback, useEffect, useRef, useState } from 'react';
import { Redirect, Stack, usePathname, useRouter } from 'expo-router';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import type { NotificationDTO } from '@haven/shared';
import { color, space, type as typeTokens } from '@haven/ui';
import * as api from '../../services/api-client.js';
import { OfflineBanner } from '../../components/Banner.js';
import { useAuth } from '../../lib/auth-context.js';
import { handleNotificationTap } from '../../lib/notification-routing.js';
import { registerForPush, subscribeToNotificationTaps } from '../../lib/push.js';
import { residentRoute } from '../../lib/resident-route.js';
import { useOnline } from '../../lib/useOnline.js';
import { ShellHeader } from '../../components/ShellHeader.js';

/**
 * Resident shell (SDD §13.4: "Bottom tabs: Home, Guests, Invite (centre +), Charges,
 * Profile"). Only verified (or suspended) residents get here — everyone else is sent
 * to the onboarding step they're on (§13.3).
 *
 * Notifications: on Android, push is registered and taps open the payload's screen
 * (§13.7). On the web there is no Expo push, so the shell polls the in-app list and
 * shows new items as a banner that, when tapped, goes through the same handler.
 */

const TABS: { path: string; label: string; glyph: string }[] = [
  { path: '/home', label: 'Home', glyph: '⌂' },
  { path: '/guests', label: 'Guests', glyph: '☰' },
  { path: '/invite', label: 'Invite', glyph: '+' },
  { path: '/charges', label: 'Charges', glyph: '₹' },
  { path: '/account', label: 'Profile', glyph: '◉' },
];
const WEB_POLL_MS = 10_000;

export default function ResidentLayout() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const online = useOnline();
  const [banner, setBanner] = useState<NotificationDTO | null>(null);
  const [unread, setUnread] = useState(0);
  const seen = useRef<Set<string> | null>(null);

  const openTap = useCallback(
    (data: unknown) =>
      handleNotificationTap(data, {
        navigate: (path) => router.push(path as never),
        markOpened: (id) => api.markNotificationOpened(id),
      }),
    [router],
  );

  const verified = user?.resident?.status === 'verified' || user?.resident?.status === 'suspended';

  useEffect(() => {
    if (!verified) return;
    void registerForPush().catch(() => undefined);
    return subscribeToNotificationTaps((data) => void openTap(data));
  }, [verified, openTap]);

  useEffect(() => {
    if (!verified) return;
    let stopped = false;
    const poll = async () => {
      try {
        const page = await api.getNotifications();
        if (stopped) return;
        setUnread(page.items.filter((n) => !n.openedAt).length);
        if (Platform.OS !== 'web') return;
        const ids = new Set(page.items.map((n) => n.id));
        if (seen.current === null) {
          seen.current = ids; // existing items aren't "new" on first load
          return;
        }
        const fresh = page.items.find((n) => !seen.current?.has(n.id) && !n.openedAt);
        seen.current = ids;
        if (fresh) setBanner(fresh);
      } catch {
        // Offline banner covers connectivity; the next poll retries.
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), WEB_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [verified, pathname]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator accessibilityLabel="Loading" />
      </View>
    );
  }
  if (!user) return <Redirect href="/sign-in" />;
  const target = residentRoute(user);
  if (target !== '/home') return <Redirect href={target as never} />;

  const onTab = TABS.some((t) => t.path === pathname);

  return (
    <View style={styles.root}>
      <OfflineBanner online={online} />
      <ShellHeader
        role="Resident"
        // Screens below the tabs (a visit, an arrival, notifications…) get Back (DEC-032).
        backTo={onTab ? null : '/home'}
        right={
          pathname === '/notifications' ? null : (
            <Pressable
              onPress={() => router.push('/notifications')}
              accessibilityRole="button"
              accessibilityLabel={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
              style={styles.bell}
            >
              <Text style={styles.bellText}>Notifications{unread > 0 ? ` (${unread})` : ''}</Text>
            </Pressable>
          )
        }
      />
      {banner ? (
        <Pressable
          style={styles.banner}
          accessibilityRole="button"
          accessibilityLabel={`${banner.title ?? ''} ${banner.body}`}
          onPress={() => {
            const tapped = banner;
            setBanner(null);
            void openTap({
              kind: tapped.kind,
              notificationId: tapped.id,
              ...(tapped.visitId ? { visitId: tapped.visitId } : {}),
              screen: tapped.screen,
            });
          }}
        >
          <BannerContent n={banner} />
        </Pressable>
      ) : null}
      <View style={styles.content}>
        <Stack screenOptions={{ headerShown: false }} />
      </View>
      {onTab ? (
        <View style={styles.tabBar} accessibilityRole="tablist">
          {TABS.map((tab) => {
            const selected = pathname === tab.path;
            const centre = tab.path === '/invite';
            return (
              <Pressable
                key={tab.path}
                // replace: tabs don't stack; screens below a tab get the header's Back.
                onPress={() => router.replace(tab.path as never)}
                accessibilityRole="tab"
                accessibilityState={{ selected }}
                aria-selected={selected}
                accessibilityLabel={tab.label}
                style={styles.tab}
              >
                <Text
                  style={[
                    styles.tabGlyph,
                    centre && styles.centreGlyph,
                    selected && styles.selected,
                  ]}
                >
                  {tab.glyph}
                </Text>
                <Text style={[styles.tabLabel, selected && styles.selected]}>{tab.label}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

function BannerContent({ n }: { n: NotificationDTO }) {
  return (
    <View>
      {n.title ? <Text style={styles.bannerTitle}>{n.title}</Text> : null}
      <Text style={styles.bannerBody}>{n.body}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  bell: { minHeight: 48, minWidth: 48, justifyContent: 'center' },
  bellText: {
    fontSize: typeTokens.size.sm,
    color: color.primary,
    fontWeight: typeTokens.weight.semibold,
  },
  banner: {
    margin: space.sm,
    padding: space.md,
    borderRadius: 12,
    backgroundColor: '#FEF3C7',
  },
  bannerTitle: {
    fontSize: typeTokens.size.body,
    fontWeight: typeTokens.weight.semibold,
    color: color.text,
  },
  bannerBody: { fontSize: typeTokens.size.sm, color: color.text },
  content: { flex: 1 },
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: color.border,
    backgroundColor: color.bg,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 56,
    paddingVertical: space.xxs,
  },
  tabGlyph: { fontSize: typeTokens.size.md, color: color.textMuted },
  centreGlyph: { fontSize: typeTokens.size.lg, color: color.primary },
  tabLabel: { fontSize: typeTokens.size.xs, color: color.textMuted },
  selected: { color: color.primary, fontWeight: typeTokens.weight.semibold },
});
