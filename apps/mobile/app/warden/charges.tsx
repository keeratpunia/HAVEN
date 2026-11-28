import { useEffect, useState } from 'react';
import { ActivityIndicator } from 'react-native';
import { staffApi } from '../../services/api-client.js';
import { useStaff } from '../../lib/staff-context.js';
import { ChargesBoard } from '../../components/staff/ChargesBoard.js';

/** Warden view of charges: everything O-01 has, plus waive and manual fines (FR-59, BR-18). */
export default function WardenCharges() {
  const { hostel } = useStaff();
  const [minFine, setMinFine] = useState<number | null>(null);
  useEffect(() => {
    if (!hostel) return;
    void staffApi
      .rules(hostel.id)
      .then((r) => setMinFine(r.config.min_manual_fine_inr))
      .catch(() => setMinFine(400));
  }, [hostel]);
  if (!hostel || minFine === null) return <ActivityIndicator accessibilityLabel="Loading" />;
  return <ChargesBoard hostelId={hostel.id} warden minFine={minFine} />;
}
