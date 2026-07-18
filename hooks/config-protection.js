#!/usr/bin/env node
/**
 * Config Protection Hook
 *
 * Blocks modifications to linter/formatter config files.
 * Agents frequently modify these to make checks pass instead of fixing
 * the actual code. This hook steers the agent back to fixing the source.
 *
 * Exit codes:
 *   0 = allow (not a config file, or first-time creation of one)
 *   2 = block (existing config file modification attempted)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MAX_STDIN = 1024 * 1024;
let raw = '';

const PROTECTED_FILES = new Set([
  // ESLint (legacy + v9 flat config, JS/TS/MJS/CJS)
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yml',
  '.eslintrc.yaml',
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  'eslint.config.mts',
  'eslint.config.cts',
  // Prettier (all config variants including ESM/TS — see prettier.io/docs/configuration)
  '.prettierrc',
  '.prettierrc.js',
  '.prettierrc.cjs',
  '.prettierrc.mjs',
  '.prettierrc.ts',
  '.prettierrc.mts',
  '.prettierrc.cts',
  '.prettierrc.json',
  '.prettierrc.json5',
  '.prettierrc.yml',
  '.prettierrc.yaml',
  '.prettierrc.toml',
  'prettier.config.js',
  'prettier.config.cjs',
  'prettier.config.mjs',
  'prettier.config.ts',
  'prettier.config.mts',
  'prettier.config.cts',
  // Biome
  'biome.json',
  'biome.jsonc',
  // Ruff (Python)
  '.ruff.toml',
  'ruff.toml',
  // Note: pyproject.toml is intentionally NOT included here because it
  // contains project metadata alongside linter config. Blocking all edits
  // to pyproject.toml would prevent legitimate dependency changes.
  // Shell / Style / Markdown
  '.shellcheckrc',
  '.stylelintrc',
  '.stylelintrc.js',
  '.stylelintrc.cjs',
  '.stylelintrc.mjs',
  '.stylelintrc.json',
  '.stylelintrc.yml',
  '.stylelintrc.yaml',
  'stylelint.config.js',
  'stylelint.config.cjs',
  'stylelint.config.mjs',
  '.markdownlint.json',
  '.markdownlint.yml',
  '.markdownlint.yaml',
  '.markdownlintrc',
  '.markdownlint-cli2.jsonc',
  '.markdownlint-cli2.yaml'
]);

// Case-folded lookup set. Default macOS (APFS) and Windows (NTFS) filesystems are
// case-INSENSITIVE, so `.ESLintRC.js` resolves to the same inode as `.eslintrc.js`
// — a plain case-sensitive Set.has(basename) would let a differently-cased path
// sail past the guard and overwrite the real config. We compare lowercased names,
// then still stat the AS-GIVEN path below: on a case-insensitive FS that stat
// resolves to the real file (so we block); on a case-sensitive FS (Linux) a
// differently-cased name is a genuinely different, non-existent file (so we allow,
// correctly). Correct on both filesystem classes.
const PROTECTED_FILES_LC = new Set(
  Array.from(PROTECTED_FILES, (name) => name.toLowerCase())
);

function parseInput(inputOrRaw) {
  if (typeof inputOrRaw === 'string') {
    try {
      return inputOrRaw.trim() ? JSON.parse(inputOrRaw) : {};
    } catch {
      return {};
    }
  }

  return inputOrRaw && typeof inputOrRaw === 'object' ? inputOrRaw : {};
}

/**
 * Exportable run() for in-process execution via run-with-flags.js.
 * Avoids the ~50-100ms spawnSync overhead when available.
 */
function run(inputOrRaw, options = {}) {
  if (options.truncated) {
    return {
      exitCode: 2,
      stderr:
        `BLOCKED: Hook input exceeded ${options.maxStdin || MAX_STDIN} bytes. ` +
        'Refusing to bypass config-protection on a truncated payload. ' +
        'Retry with a smaller edit or disable the config-protection hook temporarily.'
    };
  }

  const input = parseInput(inputOrRaw);
  const rawPath = input?.tool_input?.file_path ?? input?.tool_input?.file;
  // Guard against a non-string file_path (e.g. an object) — path.basename would
  // throw a TypeError, the process would exit 1 (NOT the blocking exit 2), and the
  // edit would proceed unguarded. A payload we can't read a path from is not a
  // recognizable config edit, so allow (exit 0) rather than crash.
  const filePath = typeof rawPath === 'string' ? rawPath : '';
  if (!filePath) return { exitCode: 0 };

  const basename = path.basename(filePath);
  if (PROTECTED_FILES_LC.has(basename.toLowerCase())) {
    // Allow first-time creation — there's no existing config to weaken.
    // The hook's purpose is blocking modifications; writing a brand-new
    // config file in a project that has none is a legitimate bootstrap
    // path (e.g. scaffolding ESLint into a fresh repo).
    //
    // Fail closed on any stat error other than ENOENT. Use lstatSync so a
    // symlink at the protected path is treated as present even if its target
    // is missing — a dangling symlink at e.g. .eslintrc.js still represents
    // an existing config entry that an agent should not silently replace.
    // fs.existsSync would swallow EACCES/EPERM as false; lstatSync exposes
    // the error code so we can treat only genuine "path not found" (ENOENT)
    // as absent.
    let exists = true;
    try {
      fs.lstatSync(filePath);
      // lstat succeeded — something (file, dir, or symlink) exists here.
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        exists = false;
      }
      // Any other error (EACCES, EPERM, ELOOP, etc.) leaves exists=true
      // so the guard is never silently weakened.
    }

    if (!exists) {
      return { exitCode: 0 };
    }

    return {
      exitCode: 2,
      stderr:
        `BLOCKED: Modifying ${basename} is not allowed. ` +
        'Fix the source code to satisfy linter/formatter rules instead of ' +
        'weakening the config. If this is a legitimate config change, ' +
        'disable the config-protection hook temporarily.'
    };
  }

  return { exitCode: 0 };
}

module.exports = { run };

// Stdin fallback for spawnSync execution
let truncated = /^(1|true|yes)$/i.test(String(process.env.ECC_HOOK_INPUT_TRUNCATED || ''));
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  if (raw.length < MAX_STDIN) {
    const remaining = MAX_STDIN - raw.length;
    raw += chunk.substring(0, remaining);
    if (chunk.length > remaining) truncated = true;
  } else {
    truncated = true;
  }
});

process.stdin.on('end', () => {
  const result = run(raw, {
    truncated,
    maxStdin: Number(process.env.ECC_HOOK_INPUT_MAX_BYTES) || MAX_STDIN
  });

  if (result.stderr) {
    process.stderr.write(result.stderr + '\n');
  }

  if (result.exitCode === 2) {
    process.exit(2);
  }

  // Allow path: exit 0 silently. (The private version echoes `raw` to stdout to
  // chain into a hook dispatcher; standalone that just re-emits the payload —
  // including the file content being written — for no benefit, so we don't.)
});
