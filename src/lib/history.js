import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Optional local history of exam attempts, stored in the user's home dir.
const DIR = path.join(os.homedir(), '.backstage-cba-prep');
export const HISTORY_FILE = path.join(DIR, 'history.json');

export function record(entry) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    let arr = [];
    if (fs.existsSync(HISTORY_FILE)) {
      try {
        arr = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      } catch {
        arr = [];
      }
    }
    if (!Array.isArray(arr)) arr = [];
    arr.push(entry);
    fs.writeFileSync(HISTORY_FILE, `${JSON.stringify(arr, null, 2)}\n`);
    return HISTORY_FILE;
  } catch {
    return null; // history is best-effort; never break the exam over it
  }
}

export function load() {
  try {
    const arr = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
