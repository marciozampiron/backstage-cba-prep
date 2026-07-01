import { validateBank } from '../lib/bank.js';
import { c } from '../lib/ui.js';

export function runValidate() {
  const { errors, count } = validateBank();
  if (errors.length === 0) {
    console.log(c.green(`\n  ✓ ${count} questions valid — 0 errors.\n`));
    return 0;
  }
  console.log(c.red(`\n  ✗ ${errors.length} problem(s) across ${count} questions:\n`));
  for (const e of errors) console.log(`    - ${e}`);
  console.log('');
  return 1;
}
