/**
 * Fence label → highlighter language.
 *
 * Models write whatever the ecosystem calls a language: `sh`, `zsh`, `console`,
 * `c++`, `Dockerfile`, `jsx`. Prism registers some of those as aliases and not
 * others, and asking it to highlight an unregistered name throws — so the mapping
 * is resolved here, against an injected `registered` predicate, and the component
 * only ever calls the highlighter with a name that answered true.
 *
 * Pure for the same reason {@link ../markdown/highlight} is: refractor is
 * ESM-only with a large transitive tree, and this is the part worth testing.
 */

/**
 * Labels that mean "do not highlight this".
 *
 * Command output and logs are the common case. Prism will happily colour a stack
 * trace as if it were code, and the false keywords read as noise.
 */
const NO_HIGHLIGHT: ReadonlySet<string> = new Set([
  'text',
  'txt',
  'plain',
  'plaintext',
  'none',
  'raw',
  'output',
  'log',
  'logs',
  'tsv',
  'csv',
]);

/**
 * Labels Prism does not register, mapped to the nearest grammar it does.
 *
 * Only consulted when the label itself is unregistered, so a future bundle that
 * adds a real `jsx` grammar wins over the approximation here.
 */
const ALIASES: Readonly<Record<string, string>> = {
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  ksh: 'bash',
  console: 'bash',
  terminal: 'bash',
  'shell-session': 'bash',
  shellsession: 'bash',
  node: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  tsx: 'typescript',
  golang: 'go',
  rs: 'rust',
  kt: 'kotlin',
  kts: 'kotlin',
  'c#': 'csharp',
  cs: 'csharp',
  'c++': 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  h: 'c',
  objc: 'objectivec',
  'obj-c': 'objectivec',
  yml: 'yaml',
  md: 'markdown',
  mdx: 'markdown',
  html: 'markup',
  htm: 'markup',
  xml: 'markup',
  svg: 'markup',
  vue: 'markup',
  svelte: 'markup',
  jinja: 'markup-templating',
  cfg: 'ini',
  conf: 'ini',
  toml: 'ini',
  env: 'bash',
  dotenv: 'bash',
  patch: 'diff',
  sqlite: 'sql',
  psql: 'sql',
  mysql: 'sql',
  postgres: 'sql',
  jsonc: 'json',
  json5: 'json',
  py: 'python',
  py3: 'python',
  python3: 'python',
  rb: 'ruby',
  pl: 'perl',
  gradle: 'kotlin',
  make: 'makefile',
  cmake: 'makefile',
};

/**
 * The language to highlight as, or `null` to render the source plain.
 *
 * @param label the fence's info string, already lowercased by the parser or not
 * @param registered whether the highlighter has that grammar
 */
export function resolveLanguage(
  label: string | undefined,
  registered: (name: string) => boolean,
): string | null {
  if (!label) return null;
  const name = label.trim().toLowerCase();
  if (!name || NO_HIGHLIGHT.has(name)) return null;

  // A guard, not politeness: `registered` throws on a non-string, and a grammar
  // name with a slash or a dot is a path, not a language.
  if (!/^[a-z0-9+#._-]+$/.test(name)) return null;

  if (registered(name)) return name;

  const aliased = Object.prototype.hasOwnProperty.call(ALIASES, name) ? ALIASES[name] : undefined;
  if (aliased && registered(aliased)) return aliased;

  return null;
}

/**
 * Above this, the block renders plain.
 *
 * Prism is linear in input but the tree it builds is not free, and this runs
 * again on every stream delta while the fence is still open. 20 kB is far past
 * any code block a person will read on a phone; past it, colour is worth less
 * than a scroll that keeps up.
 */
export const MAX_HIGHLIGHT_CHARS = 20_000;

export function shouldHighlight(code: string, language: string | null): language is string {
  return language !== null && code.length <= MAX_HIGHLIGHT_CHARS;
}
