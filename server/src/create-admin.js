// Create an admin account from the command line:
//   docker compose exec app node src/create-admin.js you@example.com "Your Name"
// A random password is generated and printed once — log in and change it (top right → Change password).
import crypto from 'node:crypto';
import { connect } from './db.js';
import { createUser } from './auth.js';

const [email, name = ''] = process.argv.slice(2);
if (!email) {
  console.error('Usage: node src/create-admin.js <email> [name]');
  process.exit(1);
}
const password = crypto.randomBytes(12).toString('base64url');
try {
  await connect();
  const u = await createUser({ email, name, password, role: 'admin', searchesPerDay: 1000 });
  console.log(`Admin created: ${u.email}`);
  console.log(`Temporary password: ${password}`);
  process.exit(0);
} catch (e) {
  console.error(`Could not create the admin: ${e.message}`);
  process.exit(1);
}
