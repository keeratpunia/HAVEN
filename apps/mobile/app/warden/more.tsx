import { useRouter } from 'expo-router';
import { Button } from '../../components/Button.js';
import { InstallAppCard } from '../../components/InstallAppCard.js';
import { StaffScreen, Strong } from '../../components/staff/StaffUi.js';
import { useAuth } from '../../lib/auth-context.js';
import { useStaff } from '../../lib/staff-context.js';
import { availableShells } from '../../lib/resident-route.js';
import { MORE } from './_layout.js';

/** "More" (SDD §13.3): Bans, Rules, Gates, Staff, Charges, Audit, Reports; role switcher; sign out. */
export default function More() {
  const router = useRouter();
  const { user, signOut } = useAuth();
  const { can } = useStaff();
  const others = user ? availableShells(user).filter((s) => s.label !== 'Warden') : [];
  return (
    <StaffScreen title="More">
      <InstallAppCard />
      {MORE.filter((i) => can(...i.roles)).map((i) => (
        <Button
          key={i.path}
          label={i.label}
          variant="secondary"
          onPress={() => router.push(i.path as never)}
        />
      ))}
      {others.length ? <Strong>Switch role</Strong> : null}
      {others.map((s) => (
        <Button
          key={s.path}
          label={`Switch to ${s.label}`}
          variant="ghost"
          onPress={() => router.replace(s.path as never)}
        />
      ))}
      <Button
        label="Sign out"
        variant="ghost"
        onPress={async () => {
          await signOut();
          router.replace('/sign-in');
        }}
      />
    </StaffScreen>
  );
}
