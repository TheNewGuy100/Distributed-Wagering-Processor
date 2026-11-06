import { MikroORM } from '@mikro-orm/postgresql';
import config from '../src/infrastructure/persistence/mikro-orm.config';

const command = process.argv[2];
const usage = 'usage: bun scripts/migrate.ts <up|down|create [name]|initial|check>';

const orm = await MikroORM.init(config);
let exitCode = 0;
try {
  const migrator = orm.migrator;
  switch (command) {
    case 'up':
    case 'down': {
      const result = command === 'up' ? await migrator.up() : await migrator.down();
      console.log(`${command}:`, result.map((m) => m.name));
      break;
    }
    case 'create': {
      // Diff entities against the migrated database and write the migration that closes the gap.
      const result = await migrator.create(undefined, false, false, process.argv[3]);
      console.log('created:', result.fileName);
      break;
    }
    case 'initial': {
      const result = await migrator.createInitial();
      console.log('created initial:', result.fileName);
      break;
    }
    case 'check': {
      // Fails the build when entities and the migrated database differ (schema drift).
      const needed = await migrator.checkSchema();
      if (needed) {
        console.error('Schema drift: entities and migrations disagree. Run `bun run migration:create` and review the result.');
        exitCode = 1;
      } else {
        console.log('Schema is in sync: entities match the migrated database.');
      }
      break;
    }
    default:
      console.error(usage);
      exitCode = 1;
  }
} finally {
  await orm.close();
}
process.exit(exitCode);
