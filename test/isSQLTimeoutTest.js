const assert = require('assert')
const { isSQLTimeout } = require('../src/boss')

const valid = [
  '7d',
  '30s',
  '2h',
  '20min',
  '500 ms',
  '500ms',
  '  30s  ' // trimmed
]

const invalid = [
  null,
  undefined,
  42,
  true,
  0,
  '0',
  '30', // if we give a number, we need units to avoid accidental milliseconds
  '',
  'abc',
  '1x',
  '1m',
  '1.5s',
  '1 week',
  '1 year',
  '1s; DROP TABLE jobs',
  "1' OR '1'='1",
  '1s 2m',
  '-1s',
  '500 millisecondss',
  '500milliseconds',
  '60 seconds',
  '21600 seconds',
  '60 second',
  '30 minutes',
  '30 minute',
  '2 hours',
  '2 hour',
  '1 days',
  '1 day',
  '  30seconds  ' // trimmed
]

let passed = 0
let failed = 0

function test (name, fn) {
  try {
    fn()
    process.stdout.write(`  ✓ ${name}\n`)
    passed++
  } catch (e) {
    process.stdout.write(`  ✗ ${name}: ${e.message}\n`)
    failed++
  }
}

console.log('isSQLTimeout')
for (const v of valid) {
  test(`accepts ${JSON.stringify(v)}`, () => assert.strictEqual(isSQLTimeout(v), true))
}
for (const v of invalid) {
  test(`rejects ${JSON.stringify(v)}`, () => assert.strictEqual(isSQLTimeout(v), false))
}

process.stdout.write(`\n${passed} passing, ${failed} failing\n`)
if (failed) process.exit(1)
