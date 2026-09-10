// Foundry project-local architecture guardrails.
//
// Enforces current slice boundaries without overfitting future internals:
// - src/domain stays dependency-light (no application, CLI, platform/infrastructure).
// - src/application stays independent from src/cli.
// - Only src/cli may import src/cli (CLI remains the composition edge).
// - A module under `<slice>/.../internal/...` may only be imported by its owning slice.
//   For src/application, the owner is the capability (src/application/<capability>);
//   planning may import planning/internal, but reviewing and CLI may not.
// - Cross-capability application imports must go through the target index.js facade;
//   reviewing -> planning/index.js is allowed, reviewing -> planning/execute.js is not.
// - Direct fs/child_process imports are confined to src/platform.
//
// Limitations (intentionally strict rather than weakened):
// - src/platform and capability directories do not exist yet; the rules already
//   allow their future shape and forbid other slices. Files outside src/
//   (tests, tools, eslint) are ignored so helpers and tests may still use Node builtins.
// - Top-level src/application/*.ts files (for example foundry.ts) carry no
//   capability and may only use capability facades, never deep files or internals.
//   The current foundry.ts only imports domain, so it stays clean.
// - A future src/infrastructure slice is treated like platform for domain
//   imports (domain may not import it) but is not granted raw fs access; extend
//   the allow-list only when that slice actually appears.
// - Only relative (./, ../) and src/-prefixed targets are resolved to slices.
//   Bare external packages are ignored.

function normalizePath(fileName) {
  return String(fileName).replaceAll('\\', '/');
}

function sliceFromSrcPath(normalized) {
  const marker = '/src/';
  const idx = normalized.lastIndexOf(marker);
  if (idx === -1) {
    if (normalized.startsWith('src/')) {
      const rest = normalized.slice(4);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        return null;
      }
      return rest.slice(0, slash);
    }
    return null;
  }
  const rest = normalized.slice(idx + marker.length);
  const slash = rest.indexOf('/');
  if (slash === -1) {
    return null;
  }
  return rest.slice(0, slash);
}

function isInSrc(normalized) {
  return normalized.includes('/src/') || normalized.startsWith('src/');
}

function isRelativeSource(source) {
  return source.startsWith('./') || source.startsWith('../');
}

function resolveRelativeTarget(importerNormalized, source) {
  const base = importerNormalized.slice(0, importerNormalized.lastIndexOf('/'));
  const parts = base.split('/');
  const segs = source.split('/');
  for (const seg of segs) {
    if (seg === '.' || seg === '') {
      continue;
    }
    if (seg === '..') {
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join('/');
}

function targetSliceFor(importerNormalized, source) {
  if (isRelativeSource(source)) {
    return sliceFromSrcPath(resolveRelativeTarget(importerNormalized, source));
  }
  if (source.startsWith('src/')) {
    return sliceFromSrcPath(source);
  }
  return null;
}

function targetNormalizedForInternalCheck(importerNormalized, source) {
  if (isRelativeSource(source)) {
    return resolveRelativeTarget(importerNormalized, source);
  }
  if (source.startsWith('src/')) {
    return source;
  }
  return null;
}

function hasInternalSegment(targetNormalized) {
  return targetNormalized.split('/').includes('internal');
}

function srcRelativePart(normalized) {
  const marker = '/src/';
  const idx = normalized.lastIndexOf(marker);
  if (idx !== -1) {
    return normalized.slice(idx + marker.length);
  }
  if (normalized.startsWith('src/')) {
    return normalized.slice(4);
  }
  return null;
}

function capabilityOfApplication(normalized) {
  const relative = srcRelativePart(normalized);
  if (relative === null || relative === undefined) {
    return null;
  }
  const parts = relative.split('/');
  if (parts[0] !== 'application') {
    return null;
  }
  if (parts.length >= 3) {
    return parts[1];
  }
  if (parts.length === 2) {
    const second = parts[1];
    if (second === '' || second.includes('.')) {
      return null;
    }
    return second;
  }
  return null;
}

function ownerOf(normalized) {
  const cap = capabilityOfApplication(normalized);
  if (cap !== null) {
    return `application/${cap}`;
  }
  return sliceFromSrcPath(normalized);
}

function basenameOf(normalized) {
  const slash = normalized.lastIndexOf('/');
  if (slash === -1) {
    return normalized;
  }
  return normalized.slice(slash + 1);
}

function isFacadeTarget(targetNormalized, targetCap) {
  const base = basenameOf(targetNormalized);
  if (base === 'index' || base.startsWith('index.')) {
    return true;
  }
  if (targetCap !== null && targetNormalized.endsWith(`/${targetCap}`)) {
    return true;
  }
  return false;
}

function staticImportSource(node) {
  const src = node.source;
  if (src === null || src === undefined) {
    return null;
  }
  return src.value;
}

function dynamicImportSource(node) {
  const src = node.source;
  if (src === null || src === undefined) {
    return null;
  }
  if (src.type !== 'Literal') {
    return null;
  }
  return src.value;
}

function isStringSource(sourceValue) {
  return sourceValue !== null && sourceValue !== undefined && sourceValue.startsWith !== undefined;
}

const noForbiddenSliceImport = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Enforce Foundry slice directions; domain stays leaf, application stays CLI-free, CLI stays composition edge.',
    },
    messages: {
      forbiddenSlice:
        'Forbidden slice import: {{importer}} must not import {{target}} ({{source}}). Domain must not import application, CLI, or platform/infrastructure; non-CLI slices must not import CLI.',
    },
    schema: [],
  },
  create(context) {
    const importerNormalized = normalizePath(context.filename);
    const importerSlice = sliceFromSrcPath(importerNormalized);
    function check(sourceValue, node) {
      if (!isStringSource(sourceValue)) {
        return;
      }
      if (importerSlice === null) {
        return;
      }
      const targetSlice = targetSliceFor(importerNormalized, sourceValue);
      if (targetSlice === null) {
        return;
      }
      if (importerSlice === targetSlice) {
        return;
      }
      if (importerSlice === 'domain') {
        if (
          targetSlice === 'application' ||
          targetSlice === 'cli' ||
          targetSlice === 'platform' ||
          targetSlice === 'infrastructure'
        ) {
          context.report({
            node,
            messageId: 'forbiddenSlice',
            data: { importer: importerSlice, target: targetSlice, source: sourceValue },
          });
        }
        return;
      }
      if (importerSlice !== 'cli' && targetSlice === 'cli') {
        context.report({
          node,
          messageId: 'forbiddenSlice',
          data: { importer: importerSlice, target: targetSlice, source: sourceValue },
        });
      }
    }
    return {
      ImportDeclaration(node) {
        check(staticImportSource(node), node);
      },
      ExportNamedDeclaration(node) {
        check(staticImportSource(node), node);
      },
      ExportAllDeclaration(node) {
        check(staticImportSource(node), node);
      },
      ImportExpression(node) {
        check(dynamicImportSource(node), node);
      },
    };
  },
};

const noCrossSliceInternal = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Keep slice internals private and force cross-capability application imports through index.js facades.',
    },
    messages: {
      internalLeak:
        'Forbidden internal import: {{source}} resolves to {{target}} internals but importer is in {{importer}}. Only {{target}} may import its own internal modules; import via public seam.',
      facadeBypass:
        'Forbidden deep import: {{importer}} must not reach {{target}} via {{source}}. Cross-capability application imports must go through {{target}}/index.js facade.',
    },
    schema: [],
  },
  create(context) {
    const importerNormalized = normalizePath(context.filename);
    const importerSlice = sliceFromSrcPath(importerNormalized);
    const importerCap = capabilityOfApplication(importerNormalized);
    const importerOwner = ownerOf(importerNormalized);
    function check(sourceValue, node) {
      if (!isStringSource(sourceValue)) {
        return;
      }
      if (importerSlice === null || importerOwner === null) {
        return;
      }
      const targetSlice = targetSliceFor(importerNormalized, sourceValue);
      if (targetSlice === null) {
        return;
      }
      const targetNormalized = targetNormalizedForInternalCheck(importerNormalized, sourceValue);
      if (targetNormalized === null) {
        return;
      }
      const targetCap = capabilityOfApplication(targetNormalized);
      const targetOwner = ownerOf(targetNormalized);
      if (targetOwner === null) {
        return;
      }
      if (hasInternalSegment(targetNormalized)) {
        if (importerOwner === targetOwner) {
          return;
        }
        context.report({
          node,
          messageId: 'internalLeak',
          data: { importer: importerOwner, target: targetOwner, source: sourceValue },
        });
        return;
      }
      if (targetCap !== null && importerCap !== targetCap) {
        if (isFacadeTarget(targetNormalized, targetCap)) {
          return;
        }
        context.report({
          node,
          messageId: 'facadeBypass',
          data: {
            importer: importerOwner,
            target: targetOwner,
            source: sourceValue,
            cap: targetCap,
          },
        });
      }
    }
    return {
      ImportDeclaration(node) {
        check(staticImportSource(node), node);
      },
      ExportNamedDeclaration(node) {
        check(staticImportSource(node), node);
      },
      ExportAllDeclaration(node) {
        check(staticImportSource(node), node);
      },
      ImportExpression(node) {
        check(dynamicImportSource(node), node);
      },
    };
  },
};

const rawPlatformSources = new Set([
  'node:fs',
  'node:fs/promises',
  'node:child_process',
  'fs',
  'fs/promises',
  'child_process',
]);

const noDirectFsImport = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Confine direct fs/child_process imports to src/platform.',
    },
    messages: {
      rawPlatform:
        'Direct {{source}} import is confined to src/platform. Expose capability via application-owned contract and implement in src/platform.',
    },
    schema: [],
  },
  create(context) {
    const importerNormalized = normalizePath(context.filename);
    function check(sourceValue, node) {
      if (!isStringSource(sourceValue)) {
        return;
      }
      if (!rawPlatformSources.has(sourceValue)) {
        return;
      }
      if (!isInSrc(importerNormalized)) {
        return;
      }
      const importerSlice = sliceFromSrcPath(importerNormalized);
      if (importerSlice === 'platform') {
        return;
      }
      context.report({
        node,
        messageId: 'rawPlatform',
        data: { source: sourceValue },
      });
    }
    return {
      ImportDeclaration(node) {
        check(staticImportSource(node), node);
      },
      ExportNamedDeclaration(node) {
        check(staticImportSource(node), node);
      },
      ExportAllDeclaration(node) {
        check(staticImportSource(node), node);
      },
      ImportExpression(node) {
        check(dynamicImportSource(node), node);
      },
    };
  },
};

/** @type {import('eslint').ESLint.Plugin} */
const architecturePlugin = {
  rules: {
    'no-forbidden-slice-import': noForbiddenSliceImport,
    'no-cross-slice-internal': noCrossSliceInternal,
    'no-direct-fs-import': noDirectFsImport,
  },
};

export default architecturePlugin;
