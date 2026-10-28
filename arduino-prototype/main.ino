/* Sweep
 by BARRAGAN <http://barraganstudio.com>
 This example code is in the public domain.

 modified 8 Nov 2013
 by Scott Fitzgerald
 https://www.arduino.cc/en/Tutorial/LibraryExamples/Sweep
*/

#include <Servo.h>
#define BREAKBEAM_PIN 7
#define BLOCK 0
#define OPEN 1

Servo myservo;  // create Servo object to control a servo
// twelve Servo objects can be created on most boards

int pos = 0;    // variable to store the servo position

int currentSensorState = HIGH;
int lastSensorState = HIGH;
bool isHigh = false; 

void setup() {
  Serial.begin(9600);
  while (!Serial){
    ;
  }
  myservo.attach(6);  // attaches the servo on pin 9 to the Servo object
  myservo.write(180);

  pinMode(BREAKBEAM_PIN, INPUT_PULLUP);
  pinMode(8, OUTPUT);
}

void loop() {
  Serial.print("Beam:");
  Serial.println(digitalRead(BREAKBEAM_PIN));
  // currentSensorState = digitalRead(BREAKBEAM_PIN);
  // // Detect state transitions to avoid flooding the Serial Monitor
  // if (currentSensorState != lastSensorState) {
  //   if (currentSensorState == LOW) {
  //     Serial.println("Breakbeam Status: BROKEN");
  //   } else {
  //     Serial.println("Breakbeam Status: CLEAR");
  //   }
  //   // Update the last known state
  //   lastSensorState = currentSensorState;
  // }

  if (Serial.available() > 0) {
    int inputVal = Serial.parseInt();
    while (Serial.available() > 0) {
      Serial.read();
    }

    if (inputVal == 2 && !isHigh) {
      digitalWrite(8, HIGH);
      isHigh = true;
    } else if (inputVal == 2 && isHigh) {
      digitalWrite(8, LOW);
      isHigh = false;
    }

    if (inputVal == 1) {
      for (int i = 180; i >= 130; i--) {
        myservo.write(i);
        delay(1);
        if (digitalRead(BREAKBEAM_PIN) == LOW) {
          myservo.write(180);
          return;
        }
      }
      while(digitalRead(BREAKBEAM_PIN) == HIGH) {
      }
      myservo.write(180);
      return;
    }

  }
  return;
}
