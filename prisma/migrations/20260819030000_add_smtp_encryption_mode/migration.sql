ALTER TABLE "outreach_sending_accounts"
ADD COLUMN "smtpEncryption" TEXT NOT NULL DEFAULT 'SSL_TLS';

UPDATE "outreach_sending_accounts"
SET "smtpEncryption" = CASE
  WHEN "smtpPort" = 587 THEN 'STARTTLS'
  WHEN "smtpSecure" = TRUE THEN 'SSL_TLS'
  ELSE 'NONE'
END;
