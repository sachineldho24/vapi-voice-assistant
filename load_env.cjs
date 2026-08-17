// Minimal .env loader. The repo ships .env.example and three documents tell you
// to copy it to .env, so .env has to actually be read - but a single-file server
// does not need a dependency for it. Shell variables win: a key already present
// in process.env is never overwritten, so `$env:WEBHOOK_TOKEN="..."` still
// overrides the file and tests can pin their own values before requiring server.
const fs = require("node:fs");
const path = require("node:path");

function loadEnv(file = path.join(__dirname, ".env")) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }

  const applied = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq < 1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length > 1 && /^".*"$/.test(value)) value = value.slice(1, -1);
    else if (value.length > 1 && /^'.*'$/.test(value)) value = value.slice(1, -1);

    if (process.env[key] === undefined) {
      process.env[key] = value;
      applied.push(key);
    }
  }
  return applied;
}

module.exports = { loadEnv };
