import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { formatDateTime, RulesConfigSchema, type RulesConfig, type RulesDTO } from '@haven/shared';
import * as api from '../../services/api-client.js';
import { staffApi } from '../../services/api-client.js';
import { useStaff } from '../../lib/staff-context.js';
import { Button } from '../../components/Button.js';
import {
  Card,
  ErrorText,
  Field,
  Muted,
  StaffScreen,
  Strong,
  staffStyles,
} from '../../components/staff/StaffUi.js';
import { DateTimeField } from '../../components/DateTimeField.js';
import { StatusText, useStatus } from '../../components/StatusText.js';

/**
 * W-06 Rules (FR-55): "Form grouped: Times, Limits, Overnight, Charges; preview of
 * changes — Save as new version". The shared RulesConfigSchema validates as you type
 * (§14 forms); the API validates again and refuses an invalid config (§4.3). Gender
 * and timezone belong to the hostel and aren't editable here.
 */

type Path = string; // dotted path into RulesConfig
interface FieldDef {
  path: Path;
  label: string;
  kind: 'time' | 'int' | 'bool';
}

const GROUPS: { title: string; fields: FieldDef[] }[] = [
  {
    title: 'Times',
    fields: [
      { path: 'visiting_start', label: 'Visiting starts', kind: 'time' },
      { path: 'last_entry_day', label: 'Last entry for day guests', kind: 'time' },
      { path: 'hard_cutoff', label: 'No entry after', kind: 'time' },
      { path: 'day_visit_latest_end', label: 'Day visits end by', kind: 'time' },
      { path: 'overnight_checkout_time', label: 'Overnight check-out by', kind: 'time' },
      { path: 'night_sweep_time', label: 'Night sweep at', kind: 'time' },
    ],
  },
  {
    title: 'Limits',
    fields: [
      { path: 'early_arrival_minutes', label: 'Early arrival allowed (min)', kind: 'int' },
      { path: 'overstay_grace_minutes', label: 'Overstay grace (min)', kind: 'int' },
      { path: 'quick_drop_minutes', label: 'Quick drop-off length (min)', kind: 'int' },
      { path: 'walk_in_timeout_minutes', label: 'Walk-in expires after (min)', kind: 'int' },
      { path: 'dispute_window_minutes', label: '"Not my guest" window (min)', kind: 'int' },
      { path: 'max_active_day_guests', label: 'Day guests per host at once', kind: 'int' },
      { path: 'invite_max_days_ahead', label: 'Invites up to (days ahead)', kind: 'int' },
      {
        path: 'overnight_max_days_ahead',
        label: 'Overnight requests up to (days ahead)',
        kind: 'int',
      },
    ],
  },
  {
    title: 'Overnight',
    fields: [
      { path: 'overnight_room.enabled', label: 'Overnight in room allowed', kind: 'bool' },
      {
        path: 'overnight_room.max_nights_per_month',
        label: 'Nights per host per month',
        kind: 'int',
      },
      { path: 'overnight_room.max_concurrent', label: 'Overnight guests at once', kind: 'int' },
      { path: 'guest_room.enabled', label: 'Guest room allowed', kind: 'bool' },
    ],
  },
  {
    title: 'Charges',
    fields: [
      {
        path: 'overnight_room.charge_per_night_inr',
        label: 'Overnight in room, ₹ per night',
        kind: 'int',
      },
      { path: 'guest_room.charge_per_night_inr', label: 'Guest room, ₹ per night', kind: 'int' },
      { path: 'min_manual_fine_inr', label: 'Minimum manual fine, ₹', kind: 'int' },
    ],
  },
];

function get(obj: unknown, path: Path): unknown {
  return path
    .split('.')
    .reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj);
}

function set(obj: RulesConfig, path: Path, value: unknown): RulesConfig {
  const copy = structuredClone(obj) as unknown as Record<string, unknown>;
  const keys = path.split('.');
  let cur = copy;
  for (const k of keys.slice(0, -1)) cur = cur[k] as Record<string, unknown>;
  cur[keys[keys.length - 1] as string] = value;
  return copy as unknown as RulesConfig;
}

export default function Rules() {
  const { hostel } = useStaff();
  const [current, setCurrent] = useState<RulesDTO | null>(null);
  const [draft, setDraft] = useState<Record<Path, string>>({});
  const [busy, setBusy] = useState(false);
  const notice = useStatus();
  const hostelId = hostel?.id ?? null;

  const load = useCallback(async () => {
    if (!hostelId) return;
    const r = await staffApi.rules(hostelId);
    setCurrent(r);
    const d: Record<Path, string> = {};
    for (const g of GROUPS) for (const f of g.fields) d[f.path] = String(get(r.config, f.path));
    setDraft(d);
  }, [hostelId]);
  useEffect(() => {
    void load().catch(() => notice.fail("Couldn't load the rules."));
  }, [load]);

  const candidate = useMemo(() => {
    if (!current) return null;
    let cfg = current.config;
    for (const g of GROUPS) {
      for (const f of g.fields) {
        const raw = draft[f.path] ?? '';
        const value =
          f.kind === 'int'
            ? raw.trim() === ''
              ? NaN
              : Number(raw)
            : f.kind === 'bool'
              ? raw === 'true'
              : raw;
        cfg = set(cfg, f.path, value);
      }
    }
    return cfg;
  }, [current, draft]);
  const parsed = candidate ? RulesConfigSchema.safeParse(candidate) : null;
  const changes =
    current && candidate
      ? GROUPS.flatMap((g) => g.fields).filter(
          (f) => String(get(current.config, f.path)) !== String(get(candidate, f.path)),
        )
      : [];

  if (!current) {
    return (
      <StaffScreen title="Rules">
        <StatusText status={notice.message} />
        <ActivityIndicator accessibilityLabel="Loading rules" />
      </StaffScreen>
    );
  }

  return (
    <StaffScreen title={`Rules — version ${current.version}`}>
      <Muted>
        {current.createdAt ? `Published ${formatDateTime(current.createdAt)}. ` : ''}Saving creates
        a new version; visits already approved keep theirs.
      </Muted>
      {GROUPS.map((g) => (
        <Card key={g.title}>
          <Strong>{g.title}</Strong>
          <View style={staffStyles.row}>
            {g.fields.map((f) =>
              f.kind === 'bool' ? (
                <Pressable
                  key={f.path}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: draft[f.path] === 'true' }}
                  aria-checked={draft[f.path] === 'true'}
                  accessibilityLabel={f.label}
                  onPress={() =>
                    setDraft({ ...draft, [f.path]: draft[f.path] === 'true' ? 'false' : 'true' })
                  }
                  style={{ minHeight: 48, justifyContent: 'center', flexBasis: 200, flexGrow: 1 }}
                >
                  <Text>
                    {draft[f.path] === 'true' ? '☑' : '☐'} {f.label}
                  </Text>
                </Pressable>
              ) : f.kind === 'time' ? (
                <View key={f.path} style={styles.timeField}>
                  <DateTimeField
                    kind="time"
                    label={f.label}
                    value={draft[f.path] ?? ''}
                    onChange={(v) => setDraft({ ...draft, [f.path]: v })}
                  />
                </View>
              ) : (
                <Field
                  key={f.path}
                  label={f.label}
                  value={draft[f.path] ?? ''}
                  onChange={(v) => setDraft({ ...draft, [f.path]: v })}
                  keyboardType={f.kind === 'int' ? 'numeric' : 'default'}
                />
              ),
            )}
          </View>
        </Card>
      ))}

      <Card>
        <Strong>Preview of changes</Strong>
        {changes.length === 0 ? <Muted>No changes yet.</Muted> : null}
        {changes.map((f) => (
          <Muted key={f.path}>
            {f.label}: {String(get(current.config, f.path))} → {String(get(candidate, f.path))}
          </Muted>
        ))}
        {parsed && !parsed.success ? (
          <ErrorText>
            {parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}
          </ErrorText>
        ) : null}
      </Card>
      <StatusText status={notice.message} />
      <Button
        label="Save as new version"
        disabled={!parsed?.success || changes.length === 0}
        loading={busy}
        onPress={async () => {
          if (!parsed?.success || !hostelId) return;
          setBusy(true);
          notice.clear();
          try {
            const saved = await staffApi.publishRules(hostelId, parsed.data);
            notice.ok(`Saved as version ${saved.version}. New entries use it now.`);
            await load();
          } catch (err) {
            notice.fail(err instanceof api.ApiError ? err.message : "Couldn't save.");
          } finally {
            setBusy(false);
          }
        }}
      />
    </StaffScreen>
  );
}

const styles = StyleSheet.create({
  // Same footprint as the other rule fields (StaffUi Field: flexBasis 200 in a row).
  timeField: { flexGrow: 1, flexBasis: 200 },
});
