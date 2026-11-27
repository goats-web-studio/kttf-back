import { z } from 'zod';

/**
 * Место в группе, за которым закреплена позиция сетки, — ADR-143.
 *
 * Лежит в `Match.seedA` / `Match.seedB` (колонки `Json`): финал начат
 * досрочно, и позиция ждёт свою группу. `groupId` — чтобы найти группу,
 * `group` — её метка для подписи «ждёт гр. B, 2 место».
 */
export const groupSeedRecordSchema = z.object({
  groupId: z.uuid(),
  group: z.string(),
  place: z.number().int().positive(),
});

export type GroupSeedRecord = z.infer<typeof groupSeedRecordSchema>;

export function parseGroupSeed(value: unknown): GroupSeedRecord | null {
  if (value === null || value === undefined) return null;

  const parsed = groupSeedRecordSchema.safeParse(value);

  return parsed.success ? parsed.data : null;
}
