import { appendFile, lstat, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';

export class UserError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'UserError';
    this.exitCode = exitCode;
  }
}

export async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

export async function canonicalDirectory(path, label = 'Directory') {
  const absolute = resolve(path);
  let canonical;
  try {
    canonical = await realpath(absolute);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new UserError(`${label} does not exist: ${absolute}`);
    throw error;
  }
  if (!(await stat(canonical)).isDirectory()) throw new UserError(`${label} is not a directory: ${absolute}`);
  return canonical;
}

export async function assertNoSymlinkPath(root, target) {
  const safeRoot = resolve(root);
  const safeTarget = resolve(target);
  const portable = relative(safeRoot, safeTarget);
  if (portable.startsWith(`..${sep}`) || portable === '..' || isAbsolute(portable)) {
    throw new UserError(`Path leaves the project directory: ${safeTarget}`);
  }

  const parts = portable === '' ? [] : portable.split(sep);
  let current = safeRoot;
  for (let index = -1; index < parts.length; index += 1) {
    if (index >= 0) current = resolve(current, parts[index]);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new UserError(`Symbolic links are not allowed in subtitle-me project state: ${current}`);
      if (index < parts.length - 1 && !info.isDirectory()) {
        throw new UserError(`Expected a directory in subtitle-me project state: ${current}`);
      }
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      throw error;
    }
  }
  return safeTarget;
}

export async function readUtf8(path) {
  const info = await lstat(path);
  if (!info.isFile()) throw new UserError(`Expected a regular file: ${resolve(path)}`);
  if (info.size > 64 * 1024 * 1024) throw new UserError(`File is larger than the 64 MiB read limit: ${resolve(path)}`);
  return decodeTextBuffer(await readFile(path));
}

export function decodeTextBuffer(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
    const body = buffer.subarray(2);
    if (body.length % 2 !== 0) throw new UserError('Invalid UTF-16LE text with an odd byte count');
    try {
      return new TextDecoder('utf-16le', { fatal: true }).decode(body).replace(/^\uFEFF/, '');
    } catch {
      throw new UserError('Invalid UTF-16LE text');
    }
  }
  if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) {
    const body = buffer.subarray(2);
    if (body.length % 2 !== 0) throw new UserError('Invalid UTF-16BE text with an odd byte count');
    try {
      return new TextDecoder('utf-16be', { fatal: true }).decode(body).replace(/^\uFEFF/, '');
    } catch {
      throw new UserError('Invalid UTF-16BE text');
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '');
  } catch {
    throw new UserError('Subtitle and JSON text must be valid UTF-8, UTF-16LE with BOM, or UTF-16BE with BOM');
  }
}

export async function readJson(path) {
  try {
    return JSON.parse(await readUtf8(path));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new UserError(`Invalid JSON in ${path}: ${error.message}`);
    }
    throw error;
  }
}

export async function atomicWrite(path, content) {
  const absolute = resolve(path);
  await ensureDir(dirname(absolute));
  const temporary = `${absolute}.tmp-${process.pid}-${Date.now()}`;
  try {
    if (Buffer.isBuffer(content) || content instanceof Uint8Array) await writeFile(temporary, content);
    else await writeFile(temporary, content, 'utf8');
    await rename(temporary, absolute);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }
}

export async function atomicWriteJson(path, value) {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function appendJsonLine(path, value) {
  const absolute = resolve(path);
  await ensureDir(dirname(absolute));
  try {
    const info = await lstat(absolute);
    if (!info.isFile()) throw new UserError(`Expected a regular file: ${absolute}`);
    if (info.size > 64 * 1024 * 1024) throw new UserError(`File is larger than the 64 MiB append limit: ${absolute}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await appendFile(absolute, `${JSON.stringify(value)}\n`, 'utf8');
}

export async function fileSize(path) {
  return (await stat(path)).size;
}

export function utcNow() {
  return new Date().toISOString();
}

export function normalizeKey(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('en-US');
}

export function defaultCaseSensitive(value) {
  return /[\p{Lu}\p{Lt}]/u.test(String(value ?? '').normalize('NFKC'));
}

export function normalizedSourceForm(value) {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');
}

export function sourceFormBucket(value) {
  const forms = new Set([normalizedSourceForm(value)]);
  for (let pass = 0; pass < 8; pass += 1) {
    const before = forms.size;
    for (const form of [...forms]) {
      forms.add(form.toLowerCase());
      forms.add(form.toUpperCase());
    }
    if (forms.size === before) break;
  }
  return [...forms].reduce((lowest, form) => form < lowest ? form : lowest);
}

function caseInsensitiveSourceFormsEqual(left, right) {
  const escaped = normalizedSourceForm(left).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}$`, 'iu').test(normalizedSourceForm(right));
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function sourceTermPattern(value, caseSensitive = defaultCaseSensitive(value)) {
  const normalized = normalizedSourceForm(value);
  const escaped = escapeRegex(normalized).replace(/\s+/g, '\\s+');
  const beginsWithWord = /^[\p{Letter}\p{Number}]/u.test(normalized);
  const endsWithWord = /[\p{Letter}\p{Number}]$/u.test(normalized);
  const prefix = beginsWithWord ? '(^|[^\\p{Letter}\\p{Number}])' : '()';
  const suffix = endsWithWord ? '(?=$|[^\\p{Letter}\\p{Number}])' : '';
  return new RegExp(`${prefix}${escaped}${suffix}`, caseSensitive ? 'gu' : 'giu');
}

export function sourceFormsOverlap(left, leftCaseSensitive, right, rightCaseSensitive) {
  const leftExact = normalizedSourceForm(left);
  const rightExact = normalizedSourceForm(right);
  if (leftCaseSensitive && rightCaseSensitive) return leftExact === rightExact;
  return (!leftCaseSensitive && caseInsensitiveSourceFormsEqual(leftExact, rightExact))
    || (!rightCaseSensitive && caseInsensitiveSourceFormsEqual(rightExact, leftExact));
}

export function sourceFormCovers(cover, coverCaseSensitive, target, targetCaseSensitive) {
  const coverExact = normalizedSourceForm(cover);
  const targetExact = normalizedSourceForm(target);
  if (coverCaseSensitive) return targetCaseSensitive && coverExact === targetExact;
  return caseInsensitiveSourceFormsEqual(coverExact, targetExact);
}

export function slugify(value) {
  const normalized = String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  let slug = [...normalized].slice(0, 48).join('');
  if (!slug) slug = 'subtitle-job';
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(slug)) slug = `${slug}-job`;
  return slug;
}

export function parseCliArgs(argv) {
  const positionals = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const equal = token.indexOf('=');
    if (equal >= 0) {
      const key = token.slice(2, equal);
      if (!key) throw new UserError('Invalid empty option name');
      if (Object.hasOwn(options, key)) throw new UserError(`Option --${key} was provided more than once`);
      options[key] = token.slice(equal + 1);
      continue;
    }
    const key = token.slice(2);
    if (!key) throw new UserError('Invalid empty option name');
    if (Object.hasOwn(options, key)) throw new UserError(`Option --${key} was provided more than once`);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return { positionals, options };
}

export function requiredOption(options, key) {
  const value = options[key];
  if (value === undefined || value === true || value === '') {
    throw new UserError(`Missing required option --${key}`);
  }
  return String(value);
}

export function booleanOption(options, key, fallback = false) {
  const value = options[key];
  if (value === undefined) return fallback;
  if (value === true) return true;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  throw new UserError(`--${key} must be yes or no`);
}

export function relativePortable(from, to) {
  return resolve(to).startsWith(resolve(from))
    ? resolve(to).slice(resolve(from).length + 1).replaceAll('\\', '/')
    : resolve(to).replaceAll('\\', '/');
}
