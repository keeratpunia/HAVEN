import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { color, shape, space, type as typeTokens } from '@haven/ui';
import { Button } from './Button.js';
import { canShareSheet, copyText, shareOnWhatsApp, shareSheet } from '../lib/share.js';

/** R-07 "Summary + Share button (WhatsApp first), Copy link". */
export function SharePanel({ message, inviteUrl }: { message: string; inviteUrl: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <View style={styles.wrap}>
      <View style={styles.preview}>
        <Text selectable style={styles.message}>
          {message}
        </Text>
      </View>
      <Button label="Share on WhatsApp" onPress={() => void shareOnWhatsApp(message)} />
      {canShareSheet ? (
        <Button label="Share…" variant="secondary" onPress={() => void shareSheet(message)} />
      ) : null}
      <Button
        label={copied ? 'Link copied' : 'Copy link'}
        variant="secondary"
        onPress={async () => {
          if (await copyText(inviteUrl)) {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }
        }}
      />
      <Text selectable style={styles.link} accessibilityLabel={`Invite link ${inviteUrl}`}>
        {inviteUrl}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.sm },
  preview: { backgroundColor: color.surface, borderRadius: shape.radius, padding: space.md },
  message: { fontSize: typeTokens.size.body, color: color.text },
  link: { fontSize: typeTokens.size.sm, color: color.primary },
});
