#!/usr/bin/env node
'use strict';

// Generates a fresh base64-encoded 32-byte key suitable for SECRETS_KEY.
// Usage: node scripts/generate-secrets-key.js
//        node scripts/generate-secrets-key.js >> .env

console.log(require('crypto').randomBytes(32).toString('base64'));
