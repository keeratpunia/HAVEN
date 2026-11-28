import { useState } from 'react';
import { View } from 'react-native';
import * as api from '../../services/api-client.js';
import { staffApi } from '../../services/api-client.js';
import { useStaff } from '../../lib/staff-context.js';
import { Button } from '../../components/Button.js';
import { StatusText, useStatus } from '../../components/StatusText.js';
import {
  Card,
  Chips,
  Field,
  Muted,
  StaffScreen,
  Strong,
  staffStyles,
} from '../../components/staff/StaffUi.js';

/**
 * Hostels (super admin, SDD §3.3 "create hostels"). It used to sit at the bottom of the
 * Staff screen, which is about people (phone test, 2026-11-28; DEC-032). A new hostel
 * then needs its warden invited (Staff) and its gate location set (Gates).
 */
export default function Hostels() {
  const { hostel, hostels, choose, reload } = useStaff();
  const [form, setForm] = useState({ code: '', name: '', gender: 'female' as 'female' | 'male' });
  const [busy, setBusy] = useState(false);
  const notice = useStatus();
  const valid = /^[A-Z0-9-]{2,12}$/.test(form.code) && form.name.trim().length >= 2;

  async function create() {
    if (!hostel) return;
    setBusy(true);
    notice.clear();
    try {
      const h = await staffApi.createHostel(hostel.id, {
        code: form.code,
        name: form.name.trim(),
        genderServed: form.gender,
      });
      await reload();
      setForm({ code: '', name: '', gender: form.gender });
      notice.ok(`${h.code} · ${h.name} created.`);
    } catch (err) {
      notice.fail(err instanceof api.ApiError ? err.message : "Couldn't create the hostel.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <StaffScreen title="Hostels">
      {hostels?.map((h) => (
        <Card key={h.id}>
          <View style={staffStyles.row}>
            <View style={staffStyles.grow}>
              <Strong>
                {h.code} · {h.name}
              </Strong>
              {h.id === hostel?.id ? <Muted>Selected</Muted> : null}
            </View>
            {h.id === hostel?.id ? null : (
              <Button
                label="Open"
                variant="secondary"
                fullWidth={false}
                onPress={() => choose(h.id)}
              />
            )}
          </View>
        </Card>
      ))}

      <Card>
        <Strong>New hostel</Strong>
        <View style={staffStyles.row}>
          <Field
            label="Code"
            value={form.code}
            onChange={(v) => setForm({ ...form, code: v.toUpperCase() })}
          />
          <Field label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
        </View>
        <Chips
          label="Hostel for"
          value={form.gender}
          onChange={(v) => setForm({ ...form, gender: v })}
          options={[
            { value: 'female', label: 'Women' },
            { value: 'male', label: 'Men' },
          ]}
        />
        <Button label="Create hostel" loading={busy} disabled={!valid} onPress={create} />
        <StatusText status={notice.message} />
      </Card>
    </StaffScreen>
  );
}
