import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const result = spawnSync('git', ['ls-files', '-z'], {
  cwd: root,
  encoding: 'utf8',
});
if (result.status !== 0) {
  console.error('Unable to inspect tracked delivery artifacts.');
  process.exit(1);
}
const forbidden = result.stdout
  .split('\0')
  .filter(Boolean)
  .filter((file) =>
    /(^|\/)(?:[^/]+\.(?:db|sqlite3?)(?:-[^/]*)?|release-backups|pre-restore-backups)(?:$|\/)/i.test(
      file,
    ),
  );
if (forbidden.length) {
  console.error('Tracked SQLite database or recovery snapshot detected.');
  process.exit(1);
}
console.log('Tracked artifact guard passed.');
