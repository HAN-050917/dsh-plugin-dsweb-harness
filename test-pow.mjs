/**
 * Validates the JS port of DeepSeekHashV1 against the vectors the reference Go
 * implementation's own tests use (those vectors came from the official WASM).
 *
 * Run: node test-pow.mjs
 */
import { deepseekHashV1Hex, solvePow, buildPrefix, solveAndBuildHeader } from './lib/pow.js';
import { deepseekHashV1 } from './lib/pow.js';

let failures = 0;
function check(label, got, want) {
  const ok = got === want;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      got  ${got}\n      want ${want}`);
}

const vectors = [
  ['', 'e594808bc5b7151ac160c6d39a02e0a8e261ed588578403099e3561dc40c26b3'],
  ['testsalt_1700000000_42', 'd4a2ea58c89e40887c933484868380c6f803eaa8dc53a3b9df8e431b921a4f09'],
  ['testsalt_1700000000_100000', 'abea2f35796b65486e9be1b36f7878c66cab021e96faa473fdf4decd31f9ba30'],
  ['abc123salt_1700000000_12345', '74b3b7452745b70e85eb32ee7f0a9ec0381d42dd5137b695da915e104fc390e1'],
];
for (const [input, want] of vectors) {
  check(`hash(${JSON.stringify(input)})`, deepseekHashV1Hex(new TextEncoder().encode(input)), want);
}

// SolvePow must recover each answer when handed that answer's own digest.
const solves = [
  ['testsalt', 1700000000, 42, 1000],
  ['testsalt', 1700000000, 500, 2000],
  ['abc123salt', 1700000000, 12345, 20000],
];
for (const [salt, expire, answer, diff] of solves) {
  const digest = deepseekHashV1Hex(
    new TextEncoder().encode(buildPrefix(salt, expire) + String(answer)),
  );
  const started = Date.now();
  const got = await solvePow(digest, salt, expire, diff);
  check(
    `solvePow(salt=${salt}, diff=${diff})`,
    String(got),
    String(answer),
  );
  console.log(`      ${Date.now() - started}ms for ${answer + 1} candidates`);
}

// End-to-end header shape.
const t0 = Buffer.from(
  deepseekHashV1(new TextEncoder().encode('salt_1712345678_777')),
).toString('hex');
const { header } = await solveAndBuildHeader({
  algorithm: 'DeepSeekHashV1',
  challenge: t0,
  salt: 'salt',
  expire_at: 1712345678,
  difficulty: 2000,
  signature: 'sig',
  target_path: '/api/v0/chat/completion',
});
const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
check('solveAndBuildHeader answer', String(decoded.answer), '777');
check(
  'solveAndBuildHeader keys',
  Object.keys(decoded).sort().join(','),
  'algorithm,answer,challenge,salt,signature,target_path',
);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
