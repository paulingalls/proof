import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { RefTree } from './git';

export class Sandbox {
  readonly path = mkdtempSync(join(tmpdir(), 'proof-sandbox-'));

  materialize(paths: Set<string>, tree: RefTree) {
    for (const path of paths) {
      const target = join(this.path, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, tree.raw(path));
      chmodSync(target, tree.modes.get(path) === '100755' ? 0o755 : 0o644);
    }
  }

  close() {
    rmSync(this.path, { recursive: true, force: true });
  }
}
