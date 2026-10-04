// Vercel serverless entry: every /api/* request (and /apps-script.gs) is handled by the same Express
// app the local server uses. The dashboard itself is served by Vercel as static files (dashboard/dist).
import { createApp } from '../server/src/app.js';

export default createApp({ serveDashboard: false });
