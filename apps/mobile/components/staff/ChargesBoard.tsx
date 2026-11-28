import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Image, StyleSheet, Text, View } from 'react-native';
import { formatDateShort, type AdminChargeDTO, type AdminResidentDTO } from '@haven/shared';
import { color, space, type as typeTokens } from '@haven/ui';
import * as api from '../../services/api-client.js';
import { staffApi } from '../../services/api-client.js';
import { Button } from '../Button.js';
import { ConfirmSheet } from '../ConfirmSheet.js';
import {
  Card,
  Chips,
  ErrorText,
  Field,
  Muted,
  StaffScreen,
  Strong,
  staffStyles,
} from './StaffUi.js';

/**
 * O-01 Charges (office) and the warden's Charges (FR-59): "Table: resident, room, kind,
 * amount, status, date; filters — Confirm / Mark paid". The warden also waives (with a
 * reason) and creates manual fines (min ₹400, BR-18). Office responses carry no guest
 * phone or photo (the API strips them); this screen never asks for them.
 */
type Status = 'all' | 'pending' | 'confirmed' | 'paid' | 'waived';
const KIND: Record<AdminChargeDTO['kind'], string> = {
  overnight_room: 'Overnight in room',
  guest_room: 'Guest room',
  fine: 'Fine',
};

export function ChargesBoard({
  hostelId,
  warden,
  minFine,
  footer,
}: {
  hostelId: string;
  warden: boolean;
  minFine: number;
  /** Shown under the list (the office shell's "Add to home screen" card). */
  footer?: ReactNode;
}) {
  const [status, setStatus] = useState<Status>('pending');
  const [q, setQ] = useState('');
  const [items, setItems] = useState<AdminChargeDTO[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Record<string, string>>({});
  const [waiving, setWaiving] = useState<AdminChargeDTO | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [fineOpen, setFineOpen] = useState(false);
  const [residentQ, setResidentQ] = useState('');
  const [residents, setResidents] = useState<AdminResidentDTO[] | null>(null);
  const [fine, setFine] = useState<{
    resident: AdminResidentDTO | null;
    amount: string;
    description: string;
  }>({ resident: null, amount: String(minFine), description: '' });

  const load = useCallback(async () => {
    const page = await staffApi.charges(hostelId, {
      status: status === 'all' ? undefined : status,
      q: q || undefined,
    });
    setItems(page.items);
    setCursor(page.nextCursor);
  }, [hostelId, status, q]);
  useEffect(() => {
    void load().catch(() => setMessage("Couldn't load charges."));
    // search runs on demand
  }, [hostelId, status]);

  async function act(fn: () => Promise<unknown>, ok: string) {
    setMessage(null);
    try {
      await fn();
      setMessage(ok);
    } catch (err) {
      setMessage(
        err instanceof api.ApiError
          ? err.status === 409
            ? 'This was updated by someone else.'
            : err.message
          : "Couldn't reach HAVEN.",
      );
    }
    await load();
  }

  const total = (items ?? []).reduce((s, c) => s + c.amountInr, 0);
  const amount = Number(fine.amount);

  return (
    <StaffScreen title="Charges">
      <View style={staffStyles.row}>
        <Field label="Resident, room or receipt" value={q} onChange={setQ} />
        <Button label="Search" fullWidth={false} onPress={() => void load()} />
        {warden ? (
          <Button
            label="Create fine"
            variant="secondary"
            fullWidth={false}
            onPress={() => setFineOpen((o) => !o)}
          />
        ) : null}
      </View>
      <Chips
        label="Status"
        value={status}
        onChange={setStatus}
        options={[
          { value: 'pending', label: 'Pending' },
          { value: 'confirmed', label: 'Confirmed' },
          { value: 'paid', label: 'Paid' },
          { value: 'waived', label: 'Waived' },
          { value: 'all', label: 'All' },
        ]}
      />

      {fineOpen ? (
        <Card>
          <Strong>Manual fine</Strong>
          {fine.resident ? (
            <Muted>
              For {fine.resident.fullName}, room {fine.resident.room}
            </Muted>
          ) : (
            <>
              <View style={staffStyles.row}>
                <Field
                  label="Find resident (name or room)"
                  value={residentQ}
                  onChange={setResidentQ}
                />
                <Button
                  label="Find"
                  fullWidth={false}
                  onPress={async () =>
                    setResidents(
                      (await staffApi.residents(hostelId, { status: 'verified', q: residentQ }))
                        .items,
                    )
                  }
                />
              </View>
              {residents?.map((r) => (
                <Button
                  key={r.userId}
                  variant="secondary"
                  label={`${r.fullName} · room ${r.room}`}
                  onPress={() => setFine({ ...fine, resident: r })}
                />
              ))}
            </>
          )}
          <View style={staffStyles.row}>
            <Field
              label={`Amount ₹ (at least ${minFine})`}
              value={fine.amount}
              onChange={(v) => setFine({ ...fine, amount: v })}
              keyboardType="numeric"
            />
            <Field
              label="What for"
              value={fine.description}
              onChange={(v) => setFine({ ...fine, description: v })}
            />
          </View>
          {fine.amount && (!Number.isInteger(amount) || amount < minFine) ? (
            <ErrorText>{`A fine is at least ₹${minFine}, in whole rupees.`}</ErrorText>
          ) : null}
          <Button
            label="Create fine"
            disabled={
              !fine.resident ||
              !Number.isInteger(amount) ||
              amount < minFine ||
              fine.description.trim().length < 2
            }
            onPress={() =>
              fine.resident &&
              act(async () => {
                await staffApi.createFine(hostelId, {
                  residentId: fine.resident?.userId ?? '',
                  amountInr: amount,
                  description: fine.description.trim(),
                });
                setFineOpen(false);
                setFine({ resident: null, amount: String(minFine), description: '' });
              }, 'Fine created. The resident sees it under Charges.')
            }
          />
        </Card>
      ) : null}

      <ErrorText>{message}</ErrorText>
      {items === null ? <ActivityIndicator accessibilityLabel="Loading charges" /> : null}
      {items && items.length > 0 ? <Muted>{`${items.length} shown · ₹${total}`}</Muted> : null}
      {items?.length === 0 ? <Muted>No charges.</Muted> : null}
      {items?.map((c) => (
        <Card key={c.id}>
          <View style={staffStyles.row}>
            {c.visit?.guestPhoto ? (
              <Image
                source={{ uri: c.visit.guestPhoto.url }}
                style={staffStyles.photo}
                accessibilityLabel={`Photo of ${c.visit.guestName}`}
              />
            ) : null}
            <View style={staffStyles.grow}>
              <Text style={styles.amount}>
                ₹{c.amountInr} · {KIND[c.kind]}
              </Text>
              <Muted>
                {c.resident.name} · room {c.resident.room} · {formatDateShort(c.createdAt)}
              </Muted>
              <Muted>
                {c.description}
                {c.visit ? ` · guest ${c.visit.guestName}` : ''}
                {c.visit?.guestPhone ? ` · ${c.visit.guestPhone}` : ''}
              </Muted>
              {c.receiptNo ? <Muted>Receipt {c.receiptNo}</Muted> : null}
              {c.waiveReason ? <Muted>Waived: {c.waiveReason}</Muted> : null}
            </View>
            <Text style={[styles.status, styles[c.status]]}>{c.status}</Text>
          </View>
          {c.status === 'pending' || c.status === 'confirmed' ? (
            <View style={staffStyles.row}>
              {c.status === 'pending' ? (
                <Button
                  label="Confirm"
                  variant="secondary"
                  fullWidth={false}
                  accessibilityLabel={`Confirm charge for ${c.resident.name}`}
                  onPress={() =>
                    act(() => staffApi.confirmCharge(hostelId, c.id), 'Charge confirmed.')
                  }
                />
              ) : null}
              <Field
                label="Receipt number"
                value={receipt[c.id] ?? ''}
                onChange={(v) => setReceipt({ ...receipt, [c.id]: v })}
              />
              <Button
                label="Mark paid"
                fullWidth={false}
                accessibilityLabel={`Mark charge for ${c.resident.name} paid`}
                disabled={!(receipt[c.id] ?? '').trim()}
                onPress={() =>
                  act(
                    () => staffApi.markPaid(hostelId, c.id, (receipt[c.id] ?? '').trim()),
                    'Marked paid.',
                  )
                }
              />
              {warden ? (
                <Button
                  label="Waive"
                  variant="danger"
                  fullWidth={false}
                  onPress={() => setWaiving(c)}
                />
              ) : null}
            </View>
          ) : null}
        </Card>
      ))}
      {cursor ? (
        <Button
          label="Load more"
          variant="secondary"
          onPress={async () => {
            const page = await staffApi.charges(hostelId, {
              status: status === 'all' ? undefined : status,
              q: q || undefined,
              cursor,
            });
            setItems((prev) => [...(prev ?? []), ...page.items]);
            setCursor(page.nextCursor);
          }}
        />
      ) : null}
      <ConfirmSheet
        visible={waiving !== null}
        title={`Waive ₹${waiving?.amountInr} for ${waiving?.resident.name}?`}
        confirmLabel="Waive charge"
        reasonLabel="Reason (required)"
        reasonRequired
        onCancel={() => setWaiving(null)}
        onConfirm={(reason) => {
          const w = waiving;
          setWaiving(null);
          if (w) void act(() => staffApi.waiveCharge(hostelId, w.id, reason), 'Charge waived.');
        }}
      />
      {footer}
    </StaffScreen>
  );
}

const styles = StyleSheet.create({
  amount: {
    fontSize: typeTokens.size.md,
    fontWeight: typeTokens.weight.semibold,
    color: color.text,
  },
  status: {
    fontSize: typeTokens.size.sm,
    fontWeight: typeTokens.weight.semibold,
    paddingHorizontal: space.xs,
    textTransform: 'capitalize',
  },
  pending: { color: color.warning },
  confirmed: { color: color.warning },
  paid: { color: color.success },
  waived: { color: color.textMuted },
});
