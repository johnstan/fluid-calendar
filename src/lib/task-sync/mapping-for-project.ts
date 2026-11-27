import { prisma } from "@/lib/prisma";

/**
 * The task list a project syncs with: as the list's main project, or as one
 * of the extra projects that also sync to it.
 */
export function findMappingForProject(projectId: string) {
  return prisma.taskListMapping.findFirst({
    where: {
      OR: [{ projectId }, { extraProjectIds: { has: projectId } }],
    },
  });
}
