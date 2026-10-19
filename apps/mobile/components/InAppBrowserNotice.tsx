import { Linking, StyleSheet, Text, View } from 'react-native';
import { chromeIntentUrl, copyFor, type InAppBrowser } from '@haven/shared';
import { color, space, type as typeTokens } from '@haven/ui';
import { Button } from './Button.js';

/**
 * E-03: in WhatsApp / Instagram / Facebook's in-app browser the camera and location
 * HAVEN needs at the gate are often blocked. Android gets an "Open in Chrome" button
 * (intent URL); iOS gets the steps to open the page in Safari. The guest can still
 * carry on here (DEC-023) — the detection is by user agent and can be wrong.
 */
export function InAppBrowserNotice(props: {
  browser: InAppBrowser;
  href: string;
  onContinue: () => void;
}) {
  const android = props.browser.os === 'android';
  const copy = copyFor(android ? 'IN_APP_BROWSER_ANDROID' : 'IN_APP_BROWSER_IOS');
  return (
    <View style={styles.container}>
      <Text style={styles.title} accessibilityRole="header">
        {copy.title}
      </Text>
      <Text style={styles.body}>{copy.body}</Text>
      {android ? (
        <Button
          label="Open in Chrome"
          onPress={() => void Linking.openURL(chromeIntentUrl(props.href))}
        />
      ) : null}
      <Button label="Continue here anyway" variant="ghost" onPress={props.onContinue} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: space.md,
    gap: space.md,
    maxWidth: 480,
    width: '100%',
    alignSelf: 'center',
  },
  title: {
    fontSize: typeTokens.size.lg,
    fontWeight: typeTokens.weight.semibold,
    color: color.text,
  },
  body: { fontSize: typeTokens.size.body, color: color.text },
});
