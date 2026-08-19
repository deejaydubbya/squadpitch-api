import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const script = readFileSync("scripts/backfill-legacy-prospect-outreach.js", "utf8");
const schema = readFileSync("prisma/schema.prisma", "utf8");

describe("legacy prospect outreach backfill contract", () => {
  it("uses a manual history status that cannot enter Ready for Email", () => {
    expect(schema).toContain("MANUAL_OUTREACH");
    expect(script).toContain('status === "MANUAL_OUTREACH"');
    expect(script).not.toContain("emailSentAt: new Date");
  });

  it("targets only prospect-lifecycle workspaces and preserves tokens/workspaces", () => {
    expect(script).toContain('client: { lifecycle: "PROSPECT" }');
    expect(script).toContain("tokensRegenerated: 0");
    expect(script).not.toContain("prospectWorkspace.delete");
  });

  it("is link-idempotent and refuses unsafe identity conflicts", () => {
    expect(script).toContain("outreachProspect:");
    expect(script).toContain("alreadyLinked");
    expect(script).toContain("Unsafe identity conflicts require manual review");
    expect(script).toContain("prospectWorkspaceId: workspace.id");
  });
});
