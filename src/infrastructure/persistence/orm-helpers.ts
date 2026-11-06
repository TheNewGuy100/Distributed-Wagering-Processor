import type { EntitySchemaWithMeta } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';

/**
 * `INSERT … ON CONFLICT DO NOTHING RETURNING pk`, through the ORM's query builder.
 *
 * Returns true when this call inserted the row, false when a conflicting row already existed. This is the
 * primitive behind idempotency and the inbox: the unique constraint, not application code, decides the race,
 * and a conflict does not abort the surrounding transaction (a plain insert + catch would).
 *
 * The casts are confined here: the builder's generics do not model conflict targets / returning on entity schemas.
 */
export async function insertIgnoringConflict(
  tx: EntityManager,
  schema: EntitySchemaWithMeta<any, any, any, any, any, any, any>,
  data: Record<string, unknown>,
  returning: string,
  conflictTarget?: string[],
): Promise<boolean> {
  const qb = (tx.createQueryBuilder(schema as never) as any).insert(data);
  const withTarget = conflictTarget ? qb.onConflict(conflictTarget) : qb.onConflict();
  const result = await withTarget.ignore().returning([returning]).execute();
  return (result.affectedRows ?? result.rows?.length ?? 0) > 0;
}
