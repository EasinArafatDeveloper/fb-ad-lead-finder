// Temporary UI-test admin: `node ui-user.mjs create <password>` / `node ui-user.mjs delete`
import { connect, col } from './src/db.js';
import { createUser } from './src/auth.js';
import { deleteWorkspaceData } from './src/projects.js';

const EMAIL = 'ui-test@test.local';
await connect();
const [cmd, pw] = process.argv.slice(2);
const old = await col('users').findOne({ email: EMAIL });
if (old) {
  await deleteWorkspaceData(old.workspaceId);
  await col('sessions').deleteMany({ userId: old._id });
  await col('users').deleteOne({ _id: old._id });
}
if (cmd === 'create') {
  await createUser({ email: EMAIL, name: 'UI Test', password: pw, role: 'admin' });
  console.log('created', EMAIL);
} else console.log('deleted', EMAIL);
process.exit(0);
