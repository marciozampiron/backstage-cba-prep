import fs from 'node:fs';

// Minimal .env loader (zero-dependency; no reliance on node --env-file).
// Existing process.env values always win, so a real exported variable is never
// overridden by the file. Not a full dotenv spec: supports `KEY=VALUE`, `#`
// comments, blank lines, and optional matching surrounding quotes.
export function loadEnv(file = '.env', env = process.env) {
  if (env.CBA_NO_DOTENV) return env; // explicit opt-out (used by hermetic CLI tests)
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return env; // no .env is fine
    throw err;
  }

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (key in env) continue; // real environment wins over the file

    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ((value[0] === '"' && value.endsWith('"')) || (value[0] === "'" && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }

  return env;
}
