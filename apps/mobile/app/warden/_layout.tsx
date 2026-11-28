import { useEffect } from 'react';
import { Redirect, Stack, usePathname, useRouter } from 'expo-router';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { color, space, type as typeTokens } from '@haven/ui';
import { useAuth } from '../../lib/auth-context.js';
import { StaffProvider, useStaff, type StaffRole } from '../../lib/staff-context.js';
import { routeForUser } from '../../lib/resident-route.js';
import { OfflineBanner } from '../../components/Banner.js';
import { useOnline } from '../../lib/useOnline.js';
import { HostelPicker } from '../../components/staff/StaffUi.js';
import * as api from '../../services/api-client.js';
import { handleNotificationTap } from '../../lib/notification-routing.js';
import { registerForPush, subscribeToNotificationTaps } from '../../lib/push.js';

/**
 * Warden shell (SDD §13.3): "Bottom tabs on mobile, left sidebar on web ≥ 1024 px:
 * Dashboard, Inside, Approvals, Residents, More (Bans, Rules, Gates, Staff, Charges,
 * Audit, Reports)". A super admin uses the same shell, seeing only what SDD §3.3 lets
 * them do. Every screen's data comes from /v1/admin, which checks again.
 */

export interface NavItem {
  path: string;
  label: string;
  roles: StaffRole[];
}

export const PRIMARY: NavItem[] = [
  { path: '/warden', label: 'Dashboard', roles: ['warden'] },
  { path: '/warden/inside', label: 'Inside', roles: ['warden', 'super_admin'] },
  { path: '/warden/approvals', label: 'Approvals', roles: ['warden', 'super_admin'] },
  { path: '/warden/residents', label: 'Residents', roles: ['warden', 'super_admin'] },
  { path: '/warden/more', label: 'More', roles: ['warden', 'super_admin'] },
];

export const MORE: NavItem[] = [
  { path: '/warden/visits', label: 'Search visits', roles: ['warden', 'super_admin'] },
  { path: '/warden/emergency', label: 'Emergency roll call', roles: ['warden'] },
  { path: '/warden/bans', label: 'Bans', roles: ['warden', 'super_admin'] },
  { path: '/warden/rules', label: 'Rules', roles: ['warden', 'super_admin'] },
  { path: '/warden/gates', label: 'Gates', roles: ['warden', 'super_admin'] },
  { path: '/warden/staff', label: 'Staff', roles: ['warden', 'super_admin'] },
  { path: '/warden/charges', label: 'Charges', roles: ['warden'] },
  { path: '/warden/audit', label: 'Audit log', roles: ['warden', 'super_admin'] },
  { path: '/warden/reports', label: 'Reports', roles: ['warden'] },
];

export default function WardenLayout() {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator accessibilityLabel="Loading" />
      </View>
    );
  }
  if (!user) return <Redirect href="/sign-in" />;
  if (!user.roles.some((r) => r.r === 'warden' || r.r === 'super_admin'))
    return <Redirect href={routeForUser(user) as never} />;
  return (
    <StaffProvider me={user}>
      <Shell />
    </StaffProvider>
  );
}

function Shell() {
  const router = useRouter();
  const pathname = usePathname();
  const online = useOnline();
  const { width } = useWindowDimensions();
  const { hostel, hostels, can } = useStaff();
  const wide = width >= 1024;

  // Wardens get N-DISPUTE, N-OVERNIGHT-REQ, N-RES-SUBMITTED, N-GATE-OFFLINE … by push;
  // a tap opens the exact screen (SDD §13.7: "W-05 for disputes").
  useEffect(() => {
    void registerForPush().catch(() => undefined);
    return subscribeToNotificationTaps(
      (data) =>
        void handleNotificationTap(data, {
          navigate: (path) => router.push(path as never),
          markOpened: (id) => api.markNotificationOpened(id),
        }),
    );
  }, [router]);

  if (hostels === null) {
    return (
      <View style={styles.center}>
        <ActivityIndicator accessibilityLabel="Loading hostels" />
      </View>
    );
  }
  if (!hostel) {
    return (
      <View style={styles.center}>
        <Text style={styles.body}>You don't have a role in any hostel yet.</Text>
      </View>
    );
  }

  const primary = PRIMARY.filter((i) => can(...i.roles));
  const items = wide
    ? [...primary.filter((i) => i.path !== '/warden/more'), ...MORE.filter((i) => can(...i.roles))]
    : primary;
  const active = (p: string) => (p === '/warden' ? pathname === '/warden' : pathname.startsWith(p));

  const nav = items.map((item) => (
    <Pressable
      key={item.path}
      onPress={() => router.replace(item.path as never)}
      accessibilityRole="tab"
      accessibilityState={{ selected: active(item.path) }}
      aria-selected={active(item.path)}
      accessibilityLabel={item.label}
      style={[wide ? styles.sideItem : styles.tab, active(item.path) && styles.navOn]}
    >
      <Text style={[styles.navText, active(item.path) && styles.navTextOn]}>{item.label}</Text>
    </Pressable>
  ));

  return (
    <View style={styles.root}>
      <View style={styles.header} accessibilityRole="header">
        <Text style={styles.logo}>HAVEN · Warden</Text>
        <HostelPicker />
      </View>
      <OfflineBanner online={online} />
      <View style={[styles.body2, wide && styles.row]}>
        {wide ? (
          <View style={styles.sidebar} accessibilityRole="tablist">
            {nav}
          </View>
        ) : null}
        <View style={styles.content}>
          <Stack screenOptions={{ headerShown: false }} />
        </View>
      </View>
      {!wide ? (
        <View style={styles.tabBar} accessibilityRole="tablist">
          {nav}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.md },
  body: { fontSize: typeTokens.size.body, color: color.textMuted },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
    paddingHorizontal: space.md,
    minHeight: 52,
    borderBottomWidth: 1,
    borderBottomColor: color.border,
    flexWrap: 'wrap',
  },
  logo: {
    fontSize: typeTokens.size.md,
    fontWeight: typeTokens.weight.semibold,
    color: color.primary,
  },
  body2: { flex: 1 },
  row: { flexDirection: 'row' },
  sidebar: {
    width: 220,
    borderRightWidth: 1,
    borderRightColor: color.border,
    paddingVertical: space.sm,
  },
  sideItem: { minHeight: 48, justifyContent: 'center', paddingHorizontal: space.md },
  content: { flex: 1 },
  tabBar: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: color.border },
  tab: { flex: 1, minHeight: 56, alignItems: 'center', justifyContent: 'center' },
  navOn: { backgroundColor: '#CCFBF1' },
  navText: { fontSize: typeTokens.size.sm, color: color.textMuted },
  navTextOn: { color: color.primary, fontWeight: typeTokens.weight.semibold },
});
