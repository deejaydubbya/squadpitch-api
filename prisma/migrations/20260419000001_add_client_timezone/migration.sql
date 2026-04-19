-- AlterTable: add timezone column with UTC default
ALTER TABLE "clients" ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'UTC';
