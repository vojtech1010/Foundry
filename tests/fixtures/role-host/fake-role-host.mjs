#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';

const scenario = process.argv[2] ?? 'settled';
const logPath = process.argv[3] ?? '';
const operation = process.argv[4] ?? '';

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      resolve(data);
    });
  });
}

function runtimeIdentity() {
  return {
    adapterVersion: 'fake-1',
    provider: 'fake-provider',
    model: 'fake-model',
    toolProfile: 'fake-profile',
  };
}

function settled() {
  return {
    schemaVersion: 1,
    status: 'settled',
    sequence: 1,
    events: [{ sequence: 1, kind: 'message', text: 'finished' }],
    narrative: '# Role result\n\nThe turn settled.',
    control: { schemaVersion: 1, outcome: 'implemented' },
  };
}

function capabilities() {
  const base = {
    schemaVersion: 1,
    protocol: 'foundry-role-host-v1',
    resumable: true,
    availableRoles: ['architect', 'coder', 'lead_coder', 'tester', 'reviewer'],
    capabilityProfiles: {
      filesystem: [
        'read_only_snapshot',
        'run_owned_worktree',
        'owned_scratch',
        'owned_capture_scratch',
      ],
      network: ['network_denied', 'runtime_origin_only'],
    },
    adapterVersion: 'fake-1',
  };
  if (scenario === 'not-resumable') {
    return { ...base, resumable: false };
  }
  if (scenario === 'missing-role') {
    return { ...base, availableRoles: base.availableRoles.filter((role) => role !== 'tester') };
  }
  if (scenario === 'missing-profile') {
    return {
      ...base,
      capabilityProfiles: { ...base.capabilityProfiles, network: ['network_denied'] },
    };
  }
  if (scenario === 'unsupported-protocol') {
    return { ...base, protocol: 'foundry-role-host-v0' };
  }
  if (scenario === 'extra-capabilities') {
    return { ...base, extra: true };
  }
  if (scenario === 'unknown-role') {
    return { ...base, availableRoles: [...base.availableRoles, 'operator'] };
  }
  return base;
}

function submitAlreadyAccepted() {
  if (logPath.length === 0) {
    return false;
  }
  const lines = readFileSync(logPath, 'utf8').split('\n');
  const submits = lines.filter((line) => line.includes('"operation":"submit"'));
  return submits.length > 1;
}

function submitCount() {
  if (logPath.length === 0) {
    return 0;
  }
  const lines = readFileSync(logPath, 'utf8').split('\n');
  return lines.filter((line) => line.includes('"operation":"submit"')).length;
}

function writeDocument(document) {
  process.stdout.write(`${JSON.stringify(document)}\n`);
}

const stdin = await readStdin();
let request = null;
try {
  request = JSON.parse(stdin);
} catch {
  request = null;
}

if (logPath.length > 0) {
  appendFileSync(
    logPath,
    `${JSON.stringify({
      operation,
      argv: process.argv,
      env: {
        FOUNDRY_FAKE_TOKEN: process.env.FOUNDRY_FAKE_TOKEN ?? null,
        FOUNDRY_FAKE_UNLISTED: process.env.FOUNDRY_FAKE_UNLISTED ?? null,
      },
      request,
    })}\n`,
  );
}

if (scenario === 'nonzero') {
  process.stderr.write('the fake role host refuses\n');
  process.exit(1);
}

const sessionId = 'session-1';
const ownershipToken = 'owner-1';

switch (operation) {
  case 'capabilities': {
    if (scenario === 'malformed') {
      process.stdout.write('{not-json');
      break;
    }
    writeDocument(capabilities());
    break;
  }
  case 'create': {
    const generation = scenario === 'mismatch-generation' ? 99 : 1;
    writeDocument({
      schemaVersion: 1,
      sessionId,
      ownershipToken,
      generation,
      sequence: 0,
      runtimeIdentity: runtimeIdentity(),
    });
    break;
  }
  case 'submit': {
    const submission =
      scenario === 'idempotent-submit' && submitAlreadyAccepted() ? 'already_accepted' : 'accepted';
    writeDocument({ schemaVersion: 1, submission });
    break;
  }
  case 'observe': {
    if (scenario === 'lost') {
      writeDocument({ schemaVersion: 1, status: 'lost', sequence: 1, events: [] });
      break;
    }
    if (scenario === 'malformed') {
      process.stdout.write('{not-json');
      break;
    }
    if (scenario === 'extra') {
      process.stdout.write(`${JSON.stringify(settled())}\nTRAILING-DOCUMENT`);
      break;
    }
    if (scenario === 'bad-control') {
      writeDocument({
        schemaVersion: 1,
        status: 'settled',
        sequence: 1,
        events: [],
        narrative: 'done',
        control: 'not-an-object',
      });
      break;
    }
    if (scenario === 'repair') {
      const narrative = '# Role result\n\nThe turn settled.';
      if (submitCount() <= 1) {
        writeDocument({
          schemaVersion: 1,
          status: 'settled',
          sequence: 1,
          events: [],
          narrative,
          control: { schemaVersion: 1, outcome: 'needs_repair' },
        });
      } else {
        writeDocument({
          schemaVersion: 1,
          status: 'settled',
          sequence: 2,
          events: [],
          narrative,
          control: { schemaVersion: 1, outcome: 'implemented' },
        });
      }
      break;
    }
    if (scenario === 'oversized') {
      writeDocument({
        schemaVersion: 1,
        status: 'settled',
        sequence: 1,
        events: [],
        narrative: 'x'.repeat(100_000),
        control: {},
      });
      break;
    }
    writeDocument(settled());
    break;
  }
  case 'stop': {
    writeDocument({ schemaVersion: 1, disposition: 'disposed' });
    break;
  }
  default: {
    process.stderr.write(`unknown operation: ${operation}\n`);
    process.exit(2);
  }
}
