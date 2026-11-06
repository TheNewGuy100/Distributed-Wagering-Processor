import { MikroORM } from '@mikro-orm/postgresql';
import config from '../src/infrastructure/persistence/mikro-orm.config';

const direction = process.argv[2];
if (direction !== 'up' && direction !== 'down') {
  console.error('usage: bun scripts/migrate.ts <up|down>');
  process.exit(1);
}

const orm = await MikroORM.init(config);
try {
  const migrator = orm.migrator;
  const result = direction === 'up' ? await migrator.up() : await migrator.down();
  console.log(`${direction}:`, result.map((m) => m.name));
} finally {
  await orm.close();
}
