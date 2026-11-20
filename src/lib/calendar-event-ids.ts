/**
 * Calendar syncs replace a feed's events wholesale. Without this, every
 * sync gave each event a new database id, so a calendar page loaded a few
 * minutes earlier held ids that no longer existed and moving or editing an
 * event failed with "not found". Reusing the previous row's id for the same
 * provider event keeps ids stable across syncs.
 */
export function reuseEventIds<
  T extends { id?: string; externalEventId?: string | null },
>(rows: T[], existing: { id: string; externalEventId: string | null }[]): T[] {
  const idByExternal = new Map<string, string>();
  for (const e of existing) {
    if (e.externalEventId && !idByExternal.has(e.externalEventId)) {
      idByExternal.set(e.externalEventId, e.id);
    }
  }
  return rows.map((row) => {
    const id = row.externalEventId
      ? idByExternal.get(row.externalEventId)
      : undefined;
    if (!id) return row;
    // Each old id is handed out once, in case the provider repeats an id
    idByExternal.delete(row.externalEventId!);
    return { ...row, id };
  });
}
