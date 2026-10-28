const fs = require('fs');
const path = require('path');

function parseEnv(filePath) {
  const env = {};
  if (fs.existsSync(filePath)) {
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx !== -1) {
        const key = trimmed.slice(0, idx).trim();
        let val = trimmed.slice(idx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        env[key] = val;
      }
    }
  }
  return env;
}

const envFileVars = parseEnv('/home/ubuntu/suranga-media-bot/.env');

module.exports = {
  apps: [
    {
      name: "media-bot-api",
      script: "artifacts/api-server/dist/index.mjs",
      cwd: "/home/ubuntu/suranga-media-bot",
      env: {
        ...envFileVars,
        NODE_ENV: "production",
        PORT: 3050
      }
    }
  ]
};
