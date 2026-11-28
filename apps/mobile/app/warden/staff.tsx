import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { formatDateTime, type StaffDTO } from '@haven/shared';
import * as api from '../../services/api-client.js';
import { staffApi } from '../../services/api-client.js';
import { useStaff } from '../../lib/staff-context.js';
import { copyText } from '../../lib/share.js';
import { shareText } from '../../lib/download.js';
import { Button } from '../../components/Button.js';
import { ConfirmSheet } from '../../components/ConfirmSheet.js';
import {
  Card,
  Chips,
  Field,
  Muted,
  StaffScreen,
  Strong,
  staffStyles,
} from '../../components/staff/StaffUi.js';
import { StatusText, useStatus } from '../../components/StatusText.js';

/**
 * W-10 Staff (FR-06, FR-07, F11): office staff list and invites — Invite. The invite is
 * a link valid 48 h, usable only with the invited Gmail address; the warden shares it.
 * A super admin invites wardens here; hostels are created on the Hostels screen (DEC-032).
 */
export default function Staff() {
  const { hostel, can } = useStaff();
  const isWarden = can('warden');
  const isSuper = can('super_admin');
  const [data, setData] = useState<StaffDTO | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'office' | 'warden'>(isWarden ? 'office' : 'warden');
  const [invite, setInvite] = useState<{ url: string; email: string; expiresAt: string } | null>(
    null,
  );
  const [deactivating, setDeactivating] = useState<{ userId: string; name: string } | null>(null);
  const notice = useStatus();
  const hostelId = hostel?.id ?? null;

  const load = useCallback(async () => {
    if (!hostelId || !isWarden) return;
    setData(await staffApi.staff(hostelId));
  }, [hostelId, isWarden]);
  useEffect(() => {
    void load().catch(() => notice.fail("Couldn't load staff."));
  }, [load]);

  const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());

  return (
    <StaffScreen title="Staff">
      <StatusText status={notice.message} />
      <Card>
        <Strong>Invite</Strong>
        {isWarden && isSuper ? (
          <Chips
            label="Role"
            value={role}
            onChange={setRole}
            options={[
              { value: 'office', label: 'Office staff' },
              { value: 'warden', label: 'Warden' },
            ]}
          />
        ) : (
          <Muted>
            {isWarden ? 'Office staff' : 'Warden'} for {hostel?.name}
          </Muted>
        )}
        <View style={staffStyles.row}>
          <Field
            label="Their Gmail address"
            value={email}
            onChange={setEmail}
            keyboardType="email-address"
          />
          <Button
            label="Invite"
            fullWidth={false}
            disabled={!emailOk}
            onPress={async () => {
              if (!hostelId) return;
              try {
                const res = await staffApi.inviteStaff(hostelId, email.trim(), role);
                setInvite({ url: res.inviteUrl, email: email.trim(), expiresAt: res.expiresAt });
                setEmail('');
                await load();
              } catch (err) {
                notice.fail(
                  err instanceof api.ApiError ? err.message : "Couldn't create the invite.",
                );
              }
            }}
          />
        </View>
        {invite ? (
          <View>
            <Muted>
              Send this link to {invite.email}. It works only for that Google account, until{' '}
              {formatDateTime(invite.expiresAt)}.
            </Muted>
            <Text selectable accessibilityLabel={`Invite link ${invite.url}`}>
              {invite.url}
            </Text>
            <View style={staffStyles.row}>
              <Button
                label="Copy link"
                variant="secondary"
                fullWidth={false}
                onPress={() => void copyText(invite.url)}
              />
              <Button
                label="Share"
                variant="secondary"
                fullWidth={false}
                onPress={() => void shareText('HAVEN staff invite', invite.url)}
              />
            </View>
          </View>
        ) : null}
      </Card>

      {isWarden ? (
        data === null ? (
          <ActivityIndicator accessibilityLabel="Loading staff" />
        ) : (
          <>
            <Strong>Team</Strong>
            {data.members.map((m) => (
              <Card key={`${m.userId}-${m.role}`}>
                <View style={staffStyles.row}>
                  <View style={staffStyles.grow}>
                    <Text>{m.fullName}</Text>
                    <Muted>
                      {m.role === 'warden' ? 'Warden' : 'Office'} · {m.email}
                      {m.active ? '' : ' · deactivated'}
                    </Muted>
                  </View>
                  {m.role === 'office' ? (
                    <Button
                      label="Deactivate"
                      variant="danger"
                      fullWidth={false}
                      accessibilityLabel={`Deactivate ${m.fullName}`}
                      onPress={() => setDeactivating({ userId: m.userId, name: m.fullName })}
                    />
                  ) : null}
                </View>
              </Card>
            ))}
            <Strong>Invites</Strong>
            {data.invites.length === 0 ? <Muted>None.</Muted> : null}
            {data.invites.map((i) => (
              <Muted key={i.id}>
                {i.email} · {i.role} ·{' '}
                {i.acceptedAt
                  ? `accepted ${formatDateTime(i.acceptedAt)}`
                  : `expires ${formatDateTime(i.expiresAt)}`}
              </Muted>
            ))}
          </>
        )
      ) : null}

      <ConfirmSheet
        visible={deactivating !== null}
        title={`Deactivate ${deactivating?.name}?`}
        body="They're signed out everywhere at once and lose access to this hostel."
        confirmLabel="Deactivate"
        onCancel={() => setDeactivating(null)}
        onConfirm={async () => {
          if (!deactivating || !hostelId) return;
          await staffApi
            .deactivateStaff(hostelId, deactivating.userId)
            .catch(() => notice.fail("Couldn't deactivate."));
          setDeactivating(null);
          await load();
        }}
      />
    </StaffScreen>
  );
}
