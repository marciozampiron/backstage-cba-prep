import { fileURLToPath } from 'node:url';
import path from 'node:path';

// src/lib/paths.js -> repo root is two levels up.
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const QUESTIONS_DIR = path.join(ROOT, 'questions');
export const SPEC_DIR = path.join(ROOT, 'spec');
