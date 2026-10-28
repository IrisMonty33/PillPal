import React, { useState } from 'react';
import { Alert, Text, TouchableOpacity, View } from 'react-native';
import { describeError, useApp } from '../store';
import { styles } from '../theme';
import { Button, Input, Label, P } from '../ui';

export function LoginScreen() {
  const { signIn, signUp } = useApp();
  const [mode, setMode] = useState<'signIn' | 'signUp'>('signIn');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');

  const submit = async () => {
    try {
      if (mode === 'signIn') await signIn(email, password);
      else await signUp({ email, password, firstName: firstName.trim() });
    } catch (err) {
      Alert.alert(mode === 'signIn' ? 'Sign in failed' : 'Sign up failed', describeError(err));
    }
  };

  return (
    <View style={styles.login}>
      <Label>{mode === 'signIn' ? 'Welcome back' : 'Create your account'}</Label>
      <P>{mode === 'signIn' ? 'Sign in to see your connected medication station.' : 'Your name is shown to caregivers you invite.'}</P>
      {mode === 'signUp' && <Input placeholder="First name" autoCapitalize="words" value={firstName} onChangeText={setFirstName} />}
      <Input placeholder="Email" autoCapitalize="none" autoCorrect={false} keyboardType="email-address" value={email} onChangeText={setEmail} />
      <Input placeholder="Password (8+ characters)" secureTextEntry value={password} onChangeText={setPassword} />
      <Button title={mode === 'signIn' ? 'Sign in' : 'Create account'} onPress={submit} />
      <TouchableOpacity onPress={() => setMode(mode === 'signIn' ? 'signUp' : 'signIn')}>
        <Text style={styles.link}>{mode === 'signIn' ? 'Create an account' : 'I already have an account'}</Text>
      </TouchableOpacity>
    </View>
  );
}
