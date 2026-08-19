ALTER TABLE "agent_outreach_prospects" ADD COLUMN "emailHtmlBody" TEXT;

CREATE TABLE "outreach_email_templates" (
  "id" TEXT NOT NULL DEFAULT 'default',
  "subject" TEXT NOT NULL,
  "textBody" TEXT NOT NULL,
  "htmlBody" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "outreach_email_templates_pkey" PRIMARY KEY ("id")
);
