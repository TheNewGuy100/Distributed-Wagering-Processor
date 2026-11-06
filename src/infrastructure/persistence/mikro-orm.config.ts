import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { entities } from './entities';

/**
 * Built per call (not once at import) so each application instance reads its environment when it is created.
 * `ORM_QUERY_LOG=true` turns the SQL log on at start-up; it is off by default (queries carry no secrets, but they
 * are noisy). Tests use it to assert on the exact SQL the ORM sends.
 */
export function buildOrmConfig(env: NodeJS.ProcessEnv = process.env) {
  return defineConfig({
    clientUrl: env.DATABASE_URL ?? 'postgresql://wagering:wagering@localhost:5432/wagering',
    entities,
    extensions: [Migrator],
    debug: env.ORM_QUERY_LOG === 'true' ? ['query'] : false,
    schemaGenerator: { skipTables: ['mikro_orm_migrations'] },
    migrations: {
      path: 'src/infrastructure/persistence/migrations',
      glob: '!(*.d).{js,ts}',
      transactional: true,
      allOrNothing: true,
      // The schema diff is computed against the real migrated database, not a snapshot file,
      // so CI needs nothing but the migrations themselves.
      snapshot: false,
    },
  });
}

/** Used by the CLI scripts and tests. */
export default buildOrmConfig();
