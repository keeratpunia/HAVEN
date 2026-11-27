import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { formatDateTime, type AuditRowDTO } from '@haven/shared';
import { staffApi } from '../../api/client.js';
import { useStaff } from '../../lib/staff-context.js';
import { Button } from '../../components/Button.js';
import { FilterSheet } from '../../components/staff/FilterSheet.js';
import {
  Card,
  ErrorText,
  Field,
  Muted,
  StaffScreen,
  staffStyles,
} from '../../components/staff/StaffUi.js';

/** W-11 Audit log (FR-58): filterable by actor, entity and date. Rows hold no raw PII. */
const isDate = (s: string) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined);

export default function Audit() {
  const { hostel } = useStaff();
  const [entity, setEntity] = useState('');
  const [actorId, setActorId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [items, setItems] = useState<AuditRowDTO[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const hostelId = hostel?.id ?? null;

  const filters = useCallback(
    (c?: string | null) => ({
      entity: entity || undefined,
      actorId: /^[0-9a-f-]{36}$/.test(actorId) ? actorId : undefined,
      from: isDate(from),
      to: isDate(to),
      cursor: c,
    }),
    [entity, actorId, from, to],
  );

  const load = useCallback(async () => {
    if (!hostelId) return;
    try {
      const page = await staffApi.audit(hostelId, filters());
      setItems(page.items);
      setCursor(page.nextCursor);
      setMessage(null);
    } catch {
      setMessage("Couldn't load the audit log.");
    }
  }, [hostelId, filters]);
  useEffect(() => {
    void load();
    // filters apply on demand
  }, [hostelId]);

  return (
    <StaffScreen title="Audit log">
      <FilterSheet
        activeCount={[entity, actorId, from, to].filter(Boolean).length}
        applyLabel="Filter"
        onApply={() => void load()}
      >
        <View style={staffStyles.row}>
          <Field label="Entity (visits, residents, charges…)" value={entity} onChange={setEntity} />
          <Field label="Actor id" value={actorId} onChange={setActorId} />
          <Field label="From (YYYY-MM-DD)" value={from} onChange={setFrom} />
          <Field label="To (YYYY-MM-DD)" value={to} onChange={setTo} />
        </View>
      </FilterSheet>
      <ErrorText>{message}</ErrorText>
      {items === null ? <ActivityIndicator accessibilityLabel="Loading" /> : null}
      {items?.length === 0 ? <Muted>No entries.</Muted> : null}
      {items?.map((r) => (
        <Card key={r.id}>
          <Text>{`${r.action} · ${r.entity}`}</Text>
          <Muted>{`${formatDateTime(r.at)} · ${r.actorName ?? r.actorType}${r.entityId ? ` · ${r.entityId}` : ''}`}</Muted>
          {(r.action.startsWith('admin.') || r.action.startsWith('read.')) && r.after ? (
            <Muted>{JSON.stringify(r.after)}</Muted>
          ) : null}
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
