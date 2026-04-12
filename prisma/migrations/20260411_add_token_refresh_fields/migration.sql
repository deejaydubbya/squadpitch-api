-- Add token refresh tracking fields to channel_connections
ALTER TABLE "channel_connections" ADD COLUMN "lastRefreshAt" TIMESTAMP(3);
ALTER TABLE "channel_connections" ADD COLUMN "refreshFailedAt" TIMESTAMP(3);

-- Add NEEDS_RECONNECT to ConnectionStatus enum
ALTER TYPE "ConnectionStatus" ADD VALUE IF NOT EXISTS 'NEEDS_RECONNECT' AFTER 'CONNECTED';
