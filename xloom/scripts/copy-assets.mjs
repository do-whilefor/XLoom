import { readdir, mkdir, copyFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
async function copy(dir = 'src') {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const source = join(dir, entry.name);
    if (entry.isDirectory()) await copy(source);
    else if (!source.endsWith('.ts')) {
      const target = source.replace(/^src/, 'dist');
      await mkdir(join(target, '..'), { recursive: true });
      await copyFile(source, target);
    }
  }
}
await copy();
await chmod('dist/cli.js', 0o755);
