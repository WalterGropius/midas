// Mint (or reuse) the engine's SpacetimeDB identity and print its token, so it
// can be stored as MIDAS_STDB_TOKEN in the Modal secret. Containers have no
// persistent disk; a fixed token keeps the engine's operator role across restarts.
import { connectStdb, ensureEngineRole } from './stdb';

async function main() {
  let token = '';
  const stdb = await connectStdb();
  await ensureEngineRole(stdb);
  token = (await import('node:fs')).readFileSync(process.env.MIDAS_STDB_TOKEN_FILE || '.midas-engine-token', 'utf8').trim();
  console.log(`identity: ${stdb.identity.toHexString()}`);
  console.log(`MIDAS_STDB_TOKEN=${token}`);
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
