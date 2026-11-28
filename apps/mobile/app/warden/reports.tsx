import { useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';
import { plusDays, toLocalDateString, VISIT_TYPE_LABELS, type ReportDTO } from '@haven/shared';
import * as api from '../../services/api-client.js';
import { adminCsv, staffApi } from '../../services/api-client.js';
import { useStaff } from '../../lib/staff-context.js';
import { saveCsv } from '../../lib/download.js';
import { Button } from '../../components/Button.js';
import { Card, Muted, StaffScreen, Strong, staffStyles } from '../../components/staff/StaffUi.js';
import { DateTimeField } from '../../components/DateTimeField.js';
import { StatusText, useStatus } from '../../components/StatusText.js';

/** W-12 Reports (FR-57): date range, counts by type/status, CSV export (audited). */
const today = toLocalDateString(new Date(), 'Asia/Kolkata');

export default function Reports() {
  const { hostel } = useStaff();
  // The FR-60 daily digest opens this screen for one day (?from=&to=).
  const params = useLocalSearchParams<{ from?: string; to?: string }>();
  const [from, setFrom] = useState(params.from ?? plusDays(today, -30));
  const [to, setTo] = useState(params.to ?? today);
  const [report, setReport] = useState<ReportDTO | null>(null);
  const notice = useStatus();
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;

  return (
    <StaffScreen title="Reports">
      <View style={staffStyles.row}>
        <DateTimeField kind="date" label="From" value={from} onChange={setFrom} />
        <DateTimeField kind="date" label="To" value={to} onChange={setTo} />
      </View>
      <View style={staffStyles.row}>
        <Button
          label="Show counts"
          fullWidth={false}
          disabled={!valid}
          onPress={async () => {
            if (!hostel) return;
            try {
              setReport(await staffApi.report(hostel.id, from, to));
              notice.clear();
            } catch (err) {
              notice.fail(err instanceof api.ApiError ? err.message : "Couldn't load the report.");
            }
          }}
        />
        <Button
          label="Export CSV"
          variant="secondary"
          fullWidth={false}
          disabled={!valid}
          onPress={async () => {
            if (hostel)
              await saveCsv(
                `visits-${from}-to-${to}.csv`,
                await adminCsv(hostel.id, `/reports/visits.csv?from=${from}&to=${to}`),
              );
          }}
        />
      </View>
      <StatusText status={notice.message} />
      {report ? (
        <Card>
          <Strong>{`${report.total} visits`}</Strong>
          {Object.entries(report.byType).map(([k, n]) => (
            <Muted
              key={k}
            >{`${VISIT_TYPE_LABELS[k as keyof typeof VISIT_TYPE_LABELS] ?? k}: ${n}`}</Muted>
          ))}
          {Object.entries(report.byStatus).map(([k, n]) => (
            <Muted key={k}>{`${k}: ${n}`}</Muted>
          ))}
          <Muted>{`Overstays ${report.flags.overstay} · disputes ${report.flags.disputed} · location not verified ${report.flags.locationUnverified} · forced exits ${report.flags.forced}`}</Muted>
        </Card>
      ) : null}
    </StaffScreen>
  );
}
