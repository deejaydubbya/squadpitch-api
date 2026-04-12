-- Add IMPORTED to MediaAssetSource enum
ALTER TYPE "MediaAssetSource" ADD VALUE IF NOT EXISTS 'IMPORTED';
