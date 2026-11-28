import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { formatDateTime, type AuditRowDTO } from '@haven/shared';
import { staffApi } from '../../services/api-client.js';
import { useStaff } from '../../lib/staff-context.js';
import { AUDIT_ENTITIES, describeAuditAction } from '../../lib/audit-labels.js';
import { Button } from '../../components/Button.js';
import { FilterSheet } from '../../components/staff/FilterSheet.js';
import {
  Card,
  Chips,
  Field,
  Muted,
  StaffScreen,
  staffStyles,
} from '../../components/staff/StaffUi.js';
import { DateTimeField } from '../../components/DateTimeField.js';
import { StatusText, useStatus } from '../../components/StatusText.js';

/**
 * W-11 Audit log (FR-58): filterable by who, what and when. Rows hold no raw PII. Each row
 * reads as a sentence ("Invited a warden") with the person and the time (DEC-032); the
 * old "Actor id" box wanted an internal id nobody could know, so it searches names now.
 */
const isDate = (s: string) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined);

function who(r: AuditRowDTO): string {
  if (r.actorName) return r.actorName;
  if (r.actorType === 'visitor') return 'A guest';
  if (r.actorType === 'device') return 'Gate screen';
  return 'HAVEN (automatic)';
}

export default function Audit() {
  const { hostel } = useStaff();
  const [entity, setEntity] = useState('');
  const [actor, setActor] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [items, setItems] = useState<AuditRowDTO[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const notice = useStatus();
  const hostelId = hostel?.id ?? null;

  const filters = useCallback(
    (c?: string | null) => ({
      entity: entity || undefined,
      actor: actor.trim() || undefined,
      from: isDate(from),
      to: isDate(to),
      cursor: c,
    }),
    [entity, actor, from, to],
  );

  const load = useCallback(async () => {
    if (!hostelId) return;
    try {
      const page = await staffApi.audit(hostelId, filters());
      setItems(page.items);
      setCursor(page.nextCursor);
      notice.clear();
    } catch {
      notice.fail("Couldn't load the audit log.");
    }
  }, [hostelId, filters]);
  useEffect(() => {
    void load();
    // the name search runs on demand; the chips apply at once
  }, [hostelId, entity]);

  return (
    <StaffScreen title="Audit log">
      <FilterSheet
        inline={
          <View style={staffStyles.row}>
            <Field label="Who" value={actor} onChange={setActor} />
          </View>
        }
        activeCount={[entity, from, to].filter(Boolean).length}
        applyLabel="Search"
        onApply={() => void load()}
      >
        <Chips label="What" value={entity} onChange={setEntity} options={AUDIT_ENTITIES} />
        <View style={staffStyles.row}>
          <DateTimeField kind="date" label="From" value={from} onChange={setFrom} />
          <DateTimeField kind="date" label="To" value={to} onChange={setTo} />
        </View>
      </FilterSheet>
      <StatusText status={notice.message} />
      {items === null ? <ActivityIndicator accessibilityLabel="Loading" /> : null}
      {items?.length === 0 ? <Muted>Nothing found.</Muted> : null}
      {items?.map((r) => (
        <Card key={r.id}>
          <Text>{describeAuditAction(r.action, r.entity)}</Text>
          <Muted>{`${who(r)} · ${formatDateTime(r.at)}`}</Muted>
        </Card>
      ))}
      {cursor ? (
        <Button
          label="Load more"
          variant="secondary"
          onPress={async () => {
            if (!hostelId) return;
            const page = await staffApi.audit(hostelId, filters(cursor));
            setItems((prev) => [...(prev ?? []), ...page.items]);
            setCursor(page.nextCursor);
          }}
        />
      ) : null}
    </StaffScreen>
  );
}
