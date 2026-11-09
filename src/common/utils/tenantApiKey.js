const path = require('node:path');
const { createHmac, randomBytes, randomUUID } = require('node:crypto');
require('dotenv').config({
  path: path.resolve(__dirname, '../../../.env'),
});

function generateTenantApiKey(pepper) {
  if (!pepper || pepper.length < 32) {
    throw new Error('API_KEY_PEPPER must be at least 32 characters.');
  }

  const apiKey = `ec_${randomBytes(32).toString('base64url')}`;
  const keyHash = createHmac('sha256', pepper)
    .update(apiKey, 'utf8')
    .digest('hex');

  return { apiKey, keyHash };
}

function generateTenantId() {
  return randomUUID();
}

const pepper = process.env.API_KEY_PEPPER;
if (!pepper) {
  throw new Error('API_KEY_PEPPER was not found in the environment or project .env file.');
}

console.log(`tenant_id: ${generateTenantId()}`);
//console.log(JSON.stringify(generateTenantApiKey(pepper), null, 2));
