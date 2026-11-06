import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';

export const databaseUrl =
  process.env.DATABASE_URL ?? 'postgresql://wagering:wagering@localhost:5432/wagering';

export default defineConfig({
  clientUrl: databaseUrl,
  entities: [],
  discovery: { warnWhenNoEntities: false },
  extensions: [Migrator],
  migrations: {
    path: 'src/infrastructure/persistence/migrations',
    glob: '!(*.d).{js,ts}',
    transactional: true,
    allOrNothing: true,
  },
});
