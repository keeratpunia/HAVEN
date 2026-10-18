import * as Haptics from 'expo-haptics';

/** SDD §13.7: "success haptic on approve; warning haptic on dispute." */
export function successHaptic(): void {
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
}

export function warningHaptic(): void {
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
}
