// ESM entry point — wraps the CommonJS dist/api.js for native ESM imports.
// import tunnrl from 'tunnrl'  →  this file  →  dist/api.js
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const tunnrl = require('./api.js');
export default tunnrl;
export const { Tunnel } = tunnrl;
