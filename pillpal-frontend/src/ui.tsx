/** Small building blocks shared by every screen. */
import React, { useState } from 'react';
import { ActivityIndicator, Text, TextInput, TouchableOpacity, View, type TextInputProps, type ViewStyle } from 'react-native';
import { muted, styles } from './theme';

export const Card = ({ children, style }: { children: React.ReactNode; style?: ViewStyle }) => <View style={[styles.card, style]}>{children}</View>;
export const Label = ({ children }: { children: React.ReactNode }) => <Text style={styles.label}>{children}</Text>;
export const P = ({ children }: { children: React.ReactNode }) => <Text style={styles.p}>{children}</Text>;
export const Section = ({ children }: { children: React.ReactNode }) => <Text style={styles.section}>{children}</Text>;
export const Empty = ({ children }: { children: React.ReactNode }) => <Text style={styles.empty}>{children}</Text>;
export const Title = ({ children }: { children: React.ReactNode }) => <Text style={styles.title}>{children}</Text>;

export function Input(props: TextInputProps & { small?: boolean }) {
  const { small, style, ...rest } = props;
  return <TextInput placeholderTextColor={muted} style={[small ? styles.inputSmall : styles.input, style]} {...rest} />;
}

/**
 * A button that disables itself while its async onPress runs, so double taps
 * never send the same request twice.
 */
export function Button({
  title,
  onPress,
  variant = 'primary',
  disabled,
}: {
  title: string;
  onPress: () => void | Promise<void>;
  variant?: 'primary' | 'small' | 'ghost';
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const press = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onPress();
    } finally {
      setBusy(false);
    }
  };
  const container = variant === 'primary' ? styles.button : variant === 'small' ? styles.buttonSmall : styles.buttonGhost;
  const text = variant === 'primary' ? styles.buttonText : variant === 'small' ? styles.buttonSmallText : styles.buttonGhostText;
  return (
    <TouchableOpacity accessibilityRole="button" style={[container, (busy || disabled) && styles.buttonDisabled]} onPress={press} disabled={busy || disabled}>
      {busy ? <ActivityIndicator color={variant === 'ghost' ? '#FF6657' : '#fff'} /> : <Text style={text}>{title}</Text>}
    </TouchableOpacity>
  );
}

export function Chip({ label, active, onPress }: { label: string; active?: boolean; onPress?: () => void }) {
  return (
    <TouchableOpacity accessibilityRole="button" style={[styles.chip, active && styles.chipActive]} onPress={onPress} disabled={!onPress}>
      <Text style={styles.chipText}>{label}</Text>
    </TouchableOpacity>
  );
}

export function Stat({ value, label }: { value: string | number; label: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}
