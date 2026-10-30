import { declarations } from './declarations';
import { RefTree } from './git';
import { Store } from './store';

export async function doctor() {
  const { project } = declarations(new RefTree('HEAD'), true);
  const diagnostic = await Store.diagnose();
  console.log(`Store: ${diagnostic.store}`);
  console.log(
    `Reachability: ${diagnostic.reason ? `unreachable (${diagnostic.reason})` : 'reachable'}`,
  );
  console.log(`Schema version: ${diagnostic.version ?? 'unavailable'}`);
  console.log(`Replica: ${diagnostic.replica}`);
  console.log(`Project: ${project}`);
  console.log(`Bun: ${Bun.version}`);
  return diagnostic.reason ? 1 : 0;
}
