import { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { color, type as typeTokens } from '@haven/ui';

/** SDD §13.5 `Countdown` — used for the 30s OTP resend timer (G-03) and the 10:00 walk-in wait (G-11). */
export function Countdown({
  seconds,
  onDone,
  label,
}: {
  seconds: number;
  onDone?: () => void;
  label?: (s: number) => string;
}) {
  const [remaining, setRemaining] = useState(seconds);

  useEffect(() => {
    setRemaining(seconds);
  }, [seconds]);

  useEffect(() => {
    if (remaining <= 0) {
      onDone?.();
      return;
    }
    const id = setTimeout(() => setRemaining((r) => r - 1), 1000);
    return () => clearTimeout(id);
  }, [remaining, onDone]);

  const mm = Math.floor(Math.max(0, remaining) / 60);
  const ss = Math.max(0, remaining) % 60;
  const text = label ? label(remaining) : `${mm}:${String(ss).padStart(2, '0')}`;

  return (
    <Text
      style={{ fontSize: typeTokens.size.body, color: color.textMuted }}
      accessibilityLiveRegion="polite"
    >
      {text}
    </Text>
  );
}
