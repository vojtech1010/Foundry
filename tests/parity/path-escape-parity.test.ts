import { describe, expect, it } from '@effect/vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isPathInside } from '../../src/domain/run-locations.js';

const IS_WINDOWS = process.platform === 'win32';

describe('path containment parity', () => {
  it('honors platform case and separator rules without loosening containment', () => {
    const root = IS_WINDOWS ? 'C:\\Foundry\\Root' : '/Foundry/Root';
    const sameCase = IS_WINDOWS ? 'c:\\foundry\\root\\sub' : '/Foundry/Root/sub';
    const differentCase = IS_WINDOWS ? 'C:\\foundry\\ROOT\\sub' : '/foundry/root/sub';
    expect(isPathInside(root, sameCase)).toBe(true);
    expect(isPathInside(root, differentCase)).toBe(IS_WINDOWS);

    const mixedSeparator = IS_WINDOWS ? 'C:\\Foundry\\Root/sub' : '/Foundry/Root\\sub';
    expect(isPathInside(root, mixedSeparator)).toBe(IS_WINDOWS);

    if (IS_WINDOWS) {
      expect(isPathInside('C:\\Foundry\\Root', 'D:\\Foundry\\Root\\sub')).toBe(false);
    }
  });

  it('keeps parent traversal inside the root and rejects escape attempts', () => {
    const root = IS_WINDOWS ? 'C:\\foundry\\root' : '/foundry/root';
    const nested = IS_WINDOWS
      ? 'C:\\foundry\\root\\sub\\..\\inside'
      : '/foundry/root/sub/../inside';
    const escaping = IS_WINDOWS
      ? 'C:\\foundry\\root\\sub\\..\\..\\outside'
      : '/foundry/root/sub/../../outside';
    expect(isPathInside(root, nested)).toBe(true);
    expect(isPathInside(root, escaping)).toBe(false);
  });

  it('rejects a symlink or junction that escapes its root once canonicalized', () => {
    const base = mkdtempSync(join(tmpdir(), 'foundry-parity-link-'));
    try {
      const root = join(base, 'root');
      const outside = join(base, 'outside');
      const inside = join(root, 'inside');
      mkdirSync(root, { recursive: true });
      mkdirSync(outside, { recursive: true });
      mkdirSync(inside, { recursive: true });

      const linkType = IS_WINDOWS ? 'junction' : 'dir';
      const escapingLink = join(root, 'escape');
      const containedLink = join(root, 'contained');
      symlinkSync(outside, escapingLink, linkType);
      symlinkSync(inside, containedLink, linkType);

      const canonicalRoot = realpathSync(root);
      expect(isPathInside(canonicalRoot, realpathSync(escapingLink))).toBe(false);
      expect(isPathInside(canonicalRoot, realpathSync(containedLink))).toBe(true);

      // The unresolved link path is lexically inside; only canonicalization
      // reveals that the escape link leaves the root. Containment is checked on
      // canonical paths so a link never widens access.
      expect(isPathInside(root, escapingLink)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
