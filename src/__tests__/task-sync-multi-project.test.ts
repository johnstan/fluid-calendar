import {
  isLinkedToMapping,
  localTasksForMappingWhere,
  mappingProjectIds,
} from "@/lib/task-sync/task-sync-manager";

jest.mock("@/lib/prisma", () => ({ prisma: {} }));
jest.mock("@/lib/logger", () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
  },
}));
jest.mock("@/lib/task-block-push", () => ({
  schedulePushTaskBlock: jest.fn(),
}));
jest.mock("@/lib/outlook-utils", () => ({ getMsGraphClient: jest.fn() }));

const johnsList = {
  projectId: "personal",
  extraProjectIds: ["private", "home"],
  externalListId: "johns-list",
  provider: { userId: "u1", type: "GOOGLE" },
};

describe("a list synced with several projects", () => {
  it("covers its main project first, then the extra ones", () => {
    expect(mappingProjectIds(johnsList)).toEqual([
      "personal",
      "private",
      "home",
    ]);
    expect(
      mappingProjectIds({ projectId: "valk", extraProjectIds: [] })
    ).toEqual(["valk"]);
  });

  it("loads the list's projects plus anything linked to the list elsewhere", () => {
    expect(localTasksForMappingWhere(johnsList)).toEqual({
      userId: "u1",
      OR: [
        { projectId: { in: ["personal", "private", "home"] } },
        { source: "GOOGLE", externalListId: "johns-list" },
      ],
    });
  });

  it("treats a task as linked by its list, whatever project it's in now", () => {
    const linked = {
      externalTaskId: "g1",
      source: "GOOGLE",
      externalListId: "johns-list",
    };
    // moved from Personal to Countr: still John's list's task
    expect(
      isLinkedToMapping({ ...linked, projectId: "countr" }, johnsList)
    ).toBe(true);
    // linked to another list: not this one's, even in one of its projects
    expect(
      isLinkedToMapping(
        { ...linked, externalListId: "countr-list", projectId: "private" },
        johnsList
      )
    ).toBe(false);
    // older links without a list recorded: go by project
    expect(
      isLinkedToMapping(
        { externalTaskId: "g2", source: "GOOGLE", projectId: "home" },
        johnsList
      )
    ).toBe(true);
    expect(
      isLinkedToMapping(
        { externalTaskId: "g3", source: "GOOGLE", projectId: "valk" },
        johnsList
      )
    ).toBe(false);
    // not linked at all
    expect(isLinkedToMapping({ projectId: "private" }, johnsList)).toBe(false);
  });
});
