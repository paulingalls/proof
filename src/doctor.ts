import { declarations } from './declarations';
import { dimension } from './dimensions';
import { RefTree } from './git';
import { Store } from './store';

export async function doctor() {
  const { project, dimensions } = declarations(new RefTree('HEAD'), true);
  const diagnostic = await Store.diagnose(project);
  console.log(`Store: ${diagnostic.store}`);
  console.log(
    `Reachability: ${diagnostic.reason ? `unreachable (${diagnostic.reason})` : 'reachable'}`,
  );
  console.log(`Schema version: ${diagnostic.version ?? 'unavailable'}`);
  console.log(`Replica: ${diagnostic.replica}`);
  console.log(`Project: ${project}`);
  console.log(`Bun: ${Bun.version}`);
  let failed = Boolean(diagnostic.reason);
  for (const [name, command] of dimensions) {
    const resolved = dimension(name, command);
    console.log(`Dimension ${name}: ${resolved.value ?? `unavailable (${resolved.reason})`}`);
    failed ||= resolved.reason !== undefined;
  }
  return failed ? 1 : 0;
}
