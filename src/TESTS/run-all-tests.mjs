#!/usr/bin/env node
/**
 * run-all-tests.mjs — Run all test sets and report combined results.
 *
 * Usage:  node src/TESTS/run-all-tests.mjs [--nif <nif>]
 *
 * Runs evaluate.mjs against each test set (TEST1, set2/TEST2) and
 * reports a combined summary.
 */

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dir = dirname(fileURLToPath(import.meta.url));
const evaluator = join(__dir, 'evaluate.mjs');

// Parse CLI args
const args = process.argv.slice(2);
let nif = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--nif' && args[i + 1]) { nif = args[++i]; }
}

const tests = [
  { name: 'TEST1 (original OCR fixtures)',     gt: join(__dir, 'TEST1') },
  { name: 'TEST2 (independent OCR fixtures)',   gt: join(__dir, 'set2', 'TEST2') },
];

let allPassed = true;

for (const test of tests) {
  if (!existsSync(test.gt)) {
    console.log(`\n⚠  Skipping ${test.name} — ground-truth file not found: ${test.gt}`);
    continue;
  }

  console.log(`\n${'═'.repeat(72)}`);
  console.log(`  ${test.name}`);
  console.log('═'.repeat(72));

  const cmdArgs = [evaluator, '--gt', test.gt, '--verbose'];
  if (nif) cmdArgs.push('--nif', nif);

  try {
    const output = execFileSync('node', cmdArgs, { encoding: 'utf8', stdio: 'pipe' });
    process.stdout.write(output);
  } catch (err) {
    // evaluate.mjs exits with 1 when not all rows pass
    if (err.stdout) process.stdout.write(err.stdout);
    if (err.stderr) process.stderr.write(err.stderr);
    allPassed = false;
  }
}

console.log('\n' + '═'.repeat(72));
console.log(allPassed ? '  ✅ All test sets passed!' : '  ❌ Some test sets have failures.');
console.log('═'.repeat(72) + '\n');

process.exit(allPassed ? 0 : 1);
