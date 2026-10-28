import React from 'react';
import { Card, Label, P, Title } from '../ui';

export function HelpScreen() {
  return (
    <>
      <Title>Help</Title>
      <Card>
        <Label>Getting started</Label>
        <P>1. Add your medications and the times you take them under Medications.</P>
        <P>2. Pair your PillPal dispenser in Settings using the code on its screen, then load each medication into a slot.</P>
        <P>3. The dispenser releases each dose on schedule. Confirm doses, or mark them taken or skipped, under Reminders.</P>
      </Card>
      <Card>
        <Label>Alerts</Label>
        <P>You will be notified when a dose is due, missed, when a slot runs low, or when the dispenser goes offline. Caregivers you invite receive the important ones too.</P>
      </Card>
      <Card>
        <Label>Important</Label>
        <P>If a dose is missed, check the dispenser and contact your care team if needed. This app does not provide medical advice.</P>
      </Card>
    </>
  );
}
