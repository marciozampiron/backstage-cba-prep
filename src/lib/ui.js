import readline from 'node:readline';

const useColor = process.env.NO_COLOR === undefined && process.stdout.isTTY;
const wrap = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const c = {
  bold: wrap('1'),
  dim: wrap('2'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  magenta: wrap('35'),
  cyan: wrap('36'),
  gray: wrap('90'),
};

export function hr(ch = '─', n = 62) {
  return c.gray(ch.repeat(n));
}

export function bar(pct) {
  const n = Math.max(0, Math.min(10, Math.round(pct / 10)));
  return c.green('█'.repeat(n)) + c.gray('░'.repeat(10 - n));
}

// Line-queue input: robust for both interactive typing and piped/non-interactive stdin
// (readline.question can drop buffered lines when several arrive at once).
let rl = null;
let closed = false;
const queue = [];
let pending = null;

function ensure() {
  if (rl) return;
  rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (pending) {
      const resolve = pending;
      pending = null;
      resolve(line);
    } else {
      queue.push(line);
    }
  });
  rl.on('close', () => {
    closed = true;
    if (pending) {
      const resolve = pending;
      pending = null;
      resolve('');
    }
  });
}

export function ask(prompt) {
  ensure();
  if (prompt) process.stdout.write(prompt);
  if (queue.length) return Promise.resolve(queue.shift());
  if (closed) return Promise.resolve('');
  return new Promise((resolve) => {
    pending = resolve;
  });
}

export function closeInput() {
  if (rl) {
    rl.close();
    rl = null;
  }
}
