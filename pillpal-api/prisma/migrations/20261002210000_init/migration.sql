-- CreateEnum
CREATE TYPE "DeviceStatus" AS ENUM ('UNCLAIMED', 'ONLINE', 'OFFLINE');

-- CreateEnum
CREATE TYPE "MedicationForm" AS ENUM ('TABLET', 'CAPSULE', 'SOFTGEL', 'OTHER');

-- CreateEnum
CREATE TYPE "DoseStatus" AS ENUM ('SCHEDULED', 'DISPENSED', 'TAKEN', 'MISSED', 'SKIPPED', 'FAILED');

-- CreateEnum
CREATE TYPE "DoseSource" AS ENUM ('SCHEDULE', 'MANUAL', 'DEVICE', 'REMOTE');

-- CreateEnum
CREATE TYPE "CommandType" AS ENUM ('DISPENSE', 'TEST_SLOT', 'TARE_SCALE', 'CALIBRATE_SCALE', 'RING', 'REBOOT', 'SYNC_NOW', 'UPDATE_SETTINGS');

-- CreateEnum
CREATE TYPE "CommandStatus" AS ENUM ('PENDING', 'SENT', 'COMPLETED', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('DOSE_REMINDER', 'DOSE_MISSED', 'DOSE_TAKEN', 'LOW_STOCK', 'DEVICE_OFFLINE', 'DEVICE_ONLINE', 'DEVICE_ERROR', 'VITALS_ALERT', 'CAREGIVER_INVITE', 'SYSTEM');

-- CreateEnum
CREATE TYPE "VitalType" AS ENUM ('BLOOD_PRESSURE', 'HEART_RATE', 'SPO2', 'TEMPERATURE', 'WEIGHT', 'GLUCOSE');

-- CreateEnum
CREATE TYPE "VitalSource" AS ENUM ('DEVICE', 'MANUAL');

-- CreateEnum
CREATE TYPE "CaregiverStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED');

-- CreateEnum
CREATE TYPE "InventoryReason" AS ENUM ('REFILL', 'DISPENSE', 'ADJUSTMENT', 'REMOVED');

-- CreateEnum
CREATE TYPE "SensorType" AS ENUM ('WEIGHT', 'BREAK_BEAM', 'TEMPERATURE', 'HUMIDITY', 'BATTERY', 'OTHER');

-- CreateEnum
CREATE TYPE "DeviceEventLevel" AS ENUM ('INFO', 'WARN', 'ERROR');

-- CreateEnum
CREATE TYPE "PushPlatform" AS ENUM ('IOS', 'ANDROID', 'WEB');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT,
    "phone" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_settings" (
    "userId" TEXT NOT NULL,
    "doseReminders" BOOLEAN NOT NULL DEFAULT true,
    "missedDoseAlerts" BOOLEAN NOT NULL DEFAULT true,
    "lowStockAlerts" BOOLEAN NOT NULL DEFAULT true,
    "deviceOfflineAlerts" BOOLEAN NOT NULL DEFAULT true,
    "vitalsAlerts" BOOLEAN NOT NULL DEFAULT true,
    "reminderLeadMinutes" INTEGER NOT NULL DEFAULT 0,
    "requireTakenConfirmation" BOOLEAN NOT NULL DEFAULT false,
    "quietHoursStart" TEXT,
    "quietHoursEnd" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_settings_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "platform" "PushPlatform" NOT NULL DEFAULT 'ANDROID',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "push_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "caregiver_links" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "caregiverId" TEXT,
    "inviteEmail" TEXT NOT NULL,
    "status" "CaregiverStatus" NOT NULL DEFAULT 'PENDING',
    "notifyMissedDoses" BOOLEAN NOT NULL DEFAULT true,
    "notifyLowStock" BOOLEAN NOT NULL DEFAULT true,
    "notifyDeviceIssues" BOOLEAN NOT NULL DEFAULT true,
    "notifyVitals" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),

    CONSTRAINT "caregiver_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" TEXT NOT NULL,
    "serialNumber" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'PillPal',
    "apiKeyHash" TEXT NOT NULL,
    "claimCode" TEXT,
    "claimCodeExpiresAt" TIMESTAMP(3),
    "ownerId" TEXT,
    "status" "DeviceStatus" NOT NULL DEFAULT 'UNCLAIMED',
    "firmwareVersion" TEXT,
    "model" TEXT,
    "ipAddress" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "offlineNotifiedAt" TIMESTAMP(3),
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "claimedAt" TIMESTAMP(3),

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slots" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "medicationId" TEXT,
    "pillCount" INTEGER NOT NULL DEFAULT 0,
    "capacity" INTEGER NOT NULL DEFAULT 50,
    "lastWeightGrams" DOUBLE PRECISION,
    "lastDispensedAt" TIMESTAMP(3),
    "lowStockNotifiedAt" TIMESTAMP(3),
    "calibration" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_commands" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "type" "CommandType" NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" "CommandStatus" NOT NULL DEFAULT 'PENDING',
    "result" JSONB,
    "error" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "device_commands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_events" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "level" "DeviceEventLevel" NOT NULL DEFAULT 'INFO',
    "type" TEXT NOT NULL,
    "message" TEXT,
    "data" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sensor_readings" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "slotId" TEXT,
    "type" "SensorType" NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "unit" TEXT,
    "meta" JSONB,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sensor_readings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "medications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "strength" TEXT,
    "form" "MedicationForm" NOT NULL DEFAULT 'TABLET',
    "color" TEXT,
    "shape" TEXT,
    "instructions" TEXT,
    "notes" TEXT,
    "prescriber" TEXT,
    "pharmacy" TEXT,
    "rxNumber" TEXT,
    "pillWeightMg" DOUBLE PRECISION,
    "refillThreshold" INTEGER NOT NULL DEFAULT 7,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "medications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedules" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "medicationId" TEXT NOT NULL,
    "label" TEXT,
    "timeOfDay" TEXT NOT NULL,
    "daysOfWeek" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "graceMinutes" INTEGER NOT NULL DEFAULT 60,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dose_events" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "medicationId" TEXT NOT NULL,
    "scheduleId" TEXT,
    "deviceId" TEXT,
    "slotId" TEXT,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "windowEndsAt" TIMESTAMP(3) NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "status" "DoseStatus" NOT NULL DEFAULT 'SCHEDULED',
    "source" "DoseSource" NOT NULL DEFAULT 'SCHEDULE',
    "dispensedAt" TIMESTAMP(3),
    "takenAt" TIMESTAMP(3),
    "skippedAt" TIMESTAMP(3),
    "detectedCount" INTEGER,
    "weightBeforeGrams" DOUBLE PRECISION,
    "weightAfterGrams" DOUBLE PRECISION,
    "failureReason" TEXT,
    "notes" TEXT,
    "reminderSentAt" TIMESTAMP(3),
    "missedAlertSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dose_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_events" (
    "id" TEXT NOT NULL,
    "slotId" TEXT NOT NULL,
    "medicationId" TEXT,
    "userId" TEXT,
    "reason" "InventoryReason" NOT NULL,
    "delta" INTEGER NOT NULL,
    "countAfter" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vital_readings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT,
    "type" "VitalType" NOT NULL,
    "source" "VitalSource" NOT NULL DEFAULT 'MANUAL',
    "systolic" INTEGER,
    "diastolic" INTEGER,
    "pulse" INTEGER,
    "value" DOUBLE PRECISION,
    "unit" TEXT,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "meta" JSONB,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vital_readings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB,
    "readAt" TIMESTAMP(3),
    "pushSentAt" TIMESTAMP(3),
    "pushError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "refresh_tokens_userId_idx" ON "refresh_tokens"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "push_tokens_token_key" ON "push_tokens"("token");

-- CreateIndex
CREATE INDEX "push_tokens_userId_idx" ON "push_tokens"("userId");

-- CreateIndex
CREATE INDEX "caregiver_links_caregiverId_idx" ON "caregiver_links"("caregiverId");

-- CreateIndex
CREATE UNIQUE INDEX "caregiver_links_patientId_inviteEmail_key" ON "caregiver_links"("patientId", "inviteEmail");

-- CreateIndex
CREATE UNIQUE INDEX "devices_serialNumber_key" ON "devices"("serialNumber");

-- CreateIndex
CREATE UNIQUE INDEX "devices_apiKeyHash_key" ON "devices"("apiKeyHash");

-- CreateIndex
CREATE UNIQUE INDEX "devices_claimCode_key" ON "devices"("claimCode");

-- CreateIndex
CREATE INDEX "devices_ownerId_idx" ON "devices"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "slots_medicationId_key" ON "slots"("medicationId");

-- CreateIndex
CREATE UNIQUE INDEX "slots_deviceId_index_key" ON "slots"("deviceId", "index");

-- CreateIndex
CREATE INDEX "device_commands_deviceId_status_idx" ON "device_commands"("deviceId", "status");

-- CreateIndex
CREATE INDEX "device_events_deviceId_occurredAt_idx" ON "device_events"("deviceId", "occurredAt");

-- CreateIndex
CREATE INDEX "sensor_readings_deviceId_type_recordedAt_idx" ON "sensor_readings"("deviceId", "type", "recordedAt");

-- CreateIndex
CREATE INDEX "medications_userId_isActive_idx" ON "medications"("userId", "isActive");

-- CreateIndex
CREATE INDEX "schedules_userId_isActive_idx" ON "schedules"("userId", "isActive");

-- CreateIndex
CREATE INDEX "dose_events_userId_scheduledAt_idx" ON "dose_events"("userId", "scheduledAt");

-- CreateIndex
CREATE INDEX "dose_events_deviceId_status_scheduledAt_idx" ON "dose_events"("deviceId", "status", "scheduledAt");

-- CreateIndex
CREATE UNIQUE INDEX "dose_events_scheduleId_scheduledAt_key" ON "dose_events"("scheduleId", "scheduledAt");

-- CreateIndex
CREATE INDEX "inventory_events_slotId_createdAt_idx" ON "inventory_events"("slotId", "createdAt");

-- CreateIndex
CREATE INDEX "vital_readings_userId_type_recordedAt_idx" ON "vital_readings"("userId", "type", "recordedAt");

-- CreateIndex
CREATE INDEX "notifications_userId_createdAt_idx" ON "notifications"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "notifications_userId_readAt_idx" ON "notifications"("userId", "readAt");

-- AddForeignKey
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_tokens" ADD CONSTRAINT "push_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "caregiver_links" ADD CONSTRAINT "caregiver_links_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "caregiver_links" ADD CONSTRAINT "caregiver_links_caregiverId_fkey" FOREIGN KEY ("caregiverId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slots" ADD CONSTRAINT "slots_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slots" ADD CONSTRAINT "slots_medicationId_fkey" FOREIGN KEY ("medicationId") REFERENCES "medications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_commands" ADD CONSTRAINT "device_commands_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_commands" ADD CONSTRAINT "device_commands_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_events" ADD CONSTRAINT "device_events_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sensor_readings" ADD CONSTRAINT "sensor_readings_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sensor_readings" ADD CONSTRAINT "sensor_readings_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "slots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medications" ADD CONSTRAINT "medications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_medicationId_fkey" FOREIGN KEY ("medicationId") REFERENCES "medications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dose_events" ADD CONSTRAINT "dose_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dose_events" ADD CONSTRAINT "dose_events_medicationId_fkey" FOREIGN KEY ("medicationId") REFERENCES "medications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dose_events" ADD CONSTRAINT "dose_events_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dose_events" ADD CONSTRAINT "dose_events_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dose_events" ADD CONSTRAINT "dose_events_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "slots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_events" ADD CONSTRAINT "inventory_events_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "slots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_events" ADD CONSTRAINT "inventory_events_medicationId_fkey" FOREIGN KEY ("medicationId") REFERENCES "medications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_events" ADD CONSTRAINT "inventory_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vital_readings" ADD CONSTRAINT "vital_readings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vital_readings" ADD CONSTRAINT "vital_readings_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
