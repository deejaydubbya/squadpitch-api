import { prisma } from "../../prisma.js";

const OPEN_STATUSES = ["PENDING", "VERIFIED", "PROCESSING"];

export async function requestAccountLifecycle({ user, auth0Sub, type }) {
  const existing = await prisma.accountLifecycleRequest.findFirst({
    where: { userId: user.id, type, status: { in: OPEN_STATUSES } },
    orderBy: { requestedAt: "desc" },
  });
  if (existing) return { request: existing, created: false };

  return prisma.$transaction(async (tx) => {
    const request = await tx.accountLifecycleRequest.create({
      data: {
        userId: user.id,
        auth0Sub,
        emailSnapshot: user.email,
        type,
      },
    });

    if (type === "DELETE_ACCOUNT") {
      const workspaces = await tx.client.findMany({
        where: { createdBy: auth0Sub, status: { not: "ARCHIVED" } },
        select: { id: true },
      });
      const workspaceIds = workspaces.map(({ id }) => id);
      if (workspaceIds.length) {
        await tx.client.updateMany({
          where: { id: { in: workspaceIds } },
          data: { status: "ARCHIVED" },
        });
        await tx.draft.updateMany({
          where: { clientId: { in: workspaceIds }, status: "SCHEDULED" },
          data: {
            status: "FAILED",
            publishError: "Account deletion requested; publishing disabled.",
          },
        });
        await tx.site.updateMany({
          where: { clientId: { in: workspaceIds } },
          data: { status: "ARCHIVED" },
        });
        await tx.channelConnection.deleteMany({
          where: { clientId: { in: workspaceIds } },
        });
        await tx.workspaceTechStackConnection.deleteMany({
          where: { workspaceId: { in: workspaceIds } },
        });
      }
    }

    return { request, created: true };
  });
}
