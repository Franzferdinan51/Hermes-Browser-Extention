import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  resolveWindowsClipPath,
  secretDisplayValue,
  shouldCopySetupSecretToClipboard,
} from '../scripts/windows-setup.mjs';

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-windows-setup-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('Windows setup does not copy setup secrets unless --clip is explicit', () => {
  assert.equal(shouldCopySetupSecretToClipboard(new Set()), false);
  assert.equal(shouldCopySetupSecretToClipboard(new Set(['--dry-run'])), false);
  assert.equal(shouldCopySetupSecretToClipboard(new Set(['--clip'])), true);
});

test('Windows setup does not print raw setup secrets unless --show-secret is explicit', () => {
  assert.equal(secretDisplayValue('PAIRING_TOKEN_SAMPLE', new Set()), '[REDACTED]');
  assert.equal(secretDisplayValue('PAIRING_TOKEN_SAMPLE', new Set(['--clip'])), '[REDACTED]');
  assert.equal(secretDisplayValue('PAIRING_TOKEN_SAMPLE', new Set(['--show-secret'])), 'PAIRING_TOKEN_SAMPLE');
  assert.equal(secretDisplayValue('', new Set(['--show-secret'])), '(none)');
});


test('Windows setup resolves clip.exe from SystemRoot instead of PATH/current directory', () => withTempDir((dir) => {
  const systemRoot = path.join(dir, 'Windows');
  const system32 = path.join(systemRoot, 'System32');
  const attackerBin = path.join(dir, 'attacker');
  fs.mkdirSync(system32, { recursive: true });
  fs.mkdirSync(attackerBin, { recursive: true });
  fs.writeFileSync(path.join(system32, 'clip.exe'), 'real clip');
  fs.writeFileSync(path.join(attackerBin, 'clip.com'), 'not real clip');

  const resolved = resolveWindowsClipPath({
    platform: 'win32',
    env: { SystemRoot: systemRoot, PATH: attackerBin },
  });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.path, path.join(system32, 'clip.exe'));
}));

test('Windows setup dry-run JSON marks clipboard fallback skipped without --clip', () => {
  const result = spawnSync(process.execPath, ['scripts/windows-setup.mjs', '--dry-run', '--json'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  const copyAction = payload.actions.find((action) => action.id === 'copy-api-server-key-fallback-to-clipboard');
  assert.equal(copyAction?.skipped, true);
  assert.equal(copyAction?.reason, 'no-clip-flag');
  assert.doesNotMatch(result.stdout, /API_SERVER_KEY=/);
});
