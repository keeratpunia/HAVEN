import { Image, StyleSheet, Text, View } from 'react-native';
import type { PhotoDTO } from '@haven/shared';
import { color, shape, space, type as typeTokens } from '@haven/ui';

/**
 * SDD §13.5 `PhotoCompare` — "two photos side by side with labels". §14: "The host's
 * arrival card puts the live photo next to the profile photo so a stranger's face is
 * obvious." The live photo is drawn larger (R-08: "live photo large, profile photo
 * small").
 */
export function PhotoCompare({
  live,
  profile,
  guestName,
}: {
  live: PhotoDTO | null;
  profile: PhotoDTO | null;
  guestName: string;
}) {
  return (
    <View style={styles.row}>
      <Slot
        photo={live}
        label="At the gate now"
        alt={`Live photo of ${guestName} at the gate`}
        big
      />
      <Slot photo={profile} label="Profile photo" alt={`Profile photo of ${guestName}`} />
    </View>
  );
}

function Slot({
  photo,
  label,
  alt,
  big,
}: {
  photo: PhotoDTO | null;
  label: string;
  alt: string;
  big?: boolean;
}) {
  return (
    <View style={[styles.slot, big ? styles.big : styles.small]}>
      {photo ? (
        <Image source={{ uri: photo.url }} style={styles.image} accessibilityLabel={alt} />
      ) : (
        <View style={[styles.image, styles.missing]}>
          <Text style={styles.missingText}>No photo</Text>
        </View>
      )}
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: space.sm, alignItems: 'flex-start' },
  slot: { gap: space.xxs },
  big: { flex: 3 },
  small: { flex: 2 },
  image: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: shape.radius,
    backgroundColor: color.border,
  },
  missing: { alignItems: 'center', justifyContent: 'center' },
  missingText: { fontSize: typeTokens.size.sm, color: color.textMuted },
  label: { fontSize: typeTokens.size.sm, color: color.textMuted, textAlign: 'center' },
});
