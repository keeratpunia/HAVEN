import { ActivityIndicator } from 'react-native';
import { useStaff } from '../../lib/staff-context.js';
import { ChargesBoard } from '../../components/staff/ChargesBoard.js';

/** O-01 Charges (office): confirm and mark paid with a receipt number (FR-59). */
export default function OfficeCharges() {
  const { hostel } = useStaff();
  if (!hostel) return <ActivityIndicator accessibilityLabel="Loading" />;
  return <ChargesBoard hostelId={hostel.id} warden={false} minFine={0} />;
}
