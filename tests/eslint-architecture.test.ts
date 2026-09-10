import { describe, expect, it } from '@effect/vitest';
import { Linter } from 'eslint';

import architecture from '../eslint/architecture.js';

const forbiddenSlice = 'foundry/no-forbidden-slice-import';
const crossSliceInternal = 'foundry/no-cross-slice-internal';
const directFs = 'foundry/no-direct-fs-import';

// Linter runs with the default JS parser, so filenames use project-relative
// .js paths. The plugin resolves slices from the src/<slice>/ path shape, the
// same shape the flat config enforces for real src/**/*.ts files.
function lintIds(code: string, filename: string): Array<string> {
  const linter = new Linter();
  const messages = linter.verify(
    code,
    {
      languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
      plugins: { foundry: architecture },
      rules: {
        'foundry/no-forbidden-slice-import': 'error',
        'foundry/no-cross-slice-internal': 'error',
        'foundry/no-direct-fs-import': 'error',
      },
    },
    filename,
  );
  const found: Array<string> = [];
  for (const message of messages) {
    const ruleId = message.ruleId;
    if (ruleId === null || ruleId === undefined) {
      continue;
    }
    found.push(ruleId);
  }
  return found;
}

describe('foundry architecture guardrails', () => {
  it('forbids domain imports of application modules', () => {
    const ids = lintIds(
      "import { summary } from '../application/foundry.js';",
      'src/domain/feature.js',
    );
    expect(ids).toContain(forbiddenSlice);
  });

  it('forbids domain imports of CLI modules', () => {
    const ids = lintIds("import { run } from '../cli/index.js';", 'src/domain/feature.js');
    expect(ids).toContain(forbiddenSlice);
  });

  it('forbids domain imports of platform modules', () => {
    const ids = lintIds("import { files } from '../platform/files.js';", 'src/domain/feature.js');
    expect(ids).toContain(forbiddenSlice);
  });

  it('allows domain imports of sibling domain modules', () => {
    const ids = lintIds("import { workflow } from './workflow.js';", 'src/domain/feature.js');
    expect(ids).toEqual([]);
  });

  it('forbids application imports of CLI modules', () => {
    const ids = lintIds("import { run } from '../cli/index.js';", 'src/application/feature.js');
    expect(ids).toContain(forbiddenSlice);
  });

  it('allows application imports of domain modules', () => {
    const ids = lintIds(
      "import { workflow } from '../domain/workflow.js';",
      'src/application/foundry.js',
    );
    expect(ids).toEqual([]);
  });

  it('allows CLI composition imports of application modules', () => {
    const ids = lintIds("import { summary } from '../application/foundry.js';", 'src/cli/index.js');
    expect(ids).toEqual([]);
  });

  it('forbids platform imports of CLI modules', () => {
    const ids = lintIds("import { run } from '../cli/index.js';", 'src/platform/files.js');
    expect(ids).toContain(forbiddenSlice);
  });

  it('allows same-slice internal imports', () => {
    const ids = lintIds("import { help } from './internal/helpers.js';", 'src/domain/feature.js');
    expect(ids).toEqual([]);
  });

  it('forbids cross-slice internal imports', () => {
    const ids = lintIds(
      "import { help } from '../domain/internal/helpers.js';",
      'src/application/feature.js',
    );
    expect(ids).toContain(crossSliceInternal);
  });

  it('forbids composition-root imports of slice internals', () => {
    const ids = lintIds(
      "import { help } from '../domain/internal/helpers.js';",
      'src/cli/feature.js',
    );
    expect(ids).toContain(crossSliceInternal);
  });

  it('allows planning to import its own internal modules', () => {
    const ids = lintIds(
      "import { help } from './internal/helpers.js';",
      'src/application/planning/feature.js',
    );
    expect(ids).toEqual([]);
  });

  it('forbids reviewing imports of planning internals', () => {
    const ids = lintIds(
      "import { help } from '../planning/internal/helpers.js';",
      'src/application/reviewing/feature.js',
    );
    expect(ids).toContain(crossSliceInternal);
  });

  it('forbids CLI imports of planning internals', () => {
    const ids = lintIds(
      "import { help } from '../application/planning/internal/helpers.js';",
      'src/cli/feature.js',
    );
    expect(ids).toContain(crossSliceInternal);
  });

  it('allows cross-capability imports through index.js facade', () => {
    const ids = lintIds(
      "import { plan } from '../planning/index.js';",
      'src/application/reviewing/feature.js',
    );
    expect(ids).toEqual([]);
  });

  it('rejects cross-capability deep imports bypassing facade', () => {
    const ids = lintIds(
      "import { run } from '../planning/execute.js';",
      'src/application/reviewing/feature.js',
    );
    expect(ids).toContain(crossSliceInternal);
  });

  it('confines node:fs to platform', () => {
    const ids = lintIds("import fs from 'node:fs';", 'src/domain/feature.js');
    expect(ids).toContain(directFs);
  });

  it('confines node:fs/promises to platform', () => {
    const ids = lintIds("import fs from 'node:fs/promises';", 'src/application/feature.js');
    expect(ids).toContain(directFs);
  });

  it('confines node:child_process to platform', () => {
    const ids = lintIds("import cp from 'node:child_process';", 'src/cli/feature.js');
    expect(ids).toContain(directFs);
  });

  it('allows platform use of node:fs', () => {
    const ids = lintIds("import fs from 'node:fs';", 'src/platform/files.js');
    expect(ids).toEqual([]);
  });

  it('covers dynamic imports for slice boundaries', () => {
    const ids = lintIds("await import('../cli/index.js');", 'src/application/feature.js');
    expect(ids).toContain(forbiddenSlice);
  });

  it('covers re-exports for slice boundaries', () => {
    const ids = lintIds("export * from '../cli/index.js';", 'src/application/feature.js');
    expect(ids).toContain(forbiddenSlice);
  });
});
