import { MAX_HIGHLIGHT_CHARS, resolveLanguage, shouldHighlight } from '@/components/markdown/lang';

/** The grammars refractor's common bundle actually registers, plus Prism's own aliases. */
const COMMON = new Set([
  'clike',
  'c',
  'cpp',
  'arduino',
  'bash',
  'csharp',
  'markup',
  'css',
  'diff',
  'go',
  'ini',
  'java',
  'regex',
  'javascript',
  'json',
  'kotlin',
  'less',
  'lua',
  'makefile',
  'yaml',
  'markdown',
  'objectivec',
  'perl',
  'markup-templating',
  'php',
  'python',
  'r',
  'ruby',
  'rust',
  'sass',
  'scss',
  'sql',
  'swift',
  'typescript',
  'basic',
  'vbnet',
  // Aliases Prism registers itself.
  'js',
  'ts',
  'py',
  'rb',
  'sh',
  'yml',
  'md',
  'html',
]);

const registered = (name: string): boolean => COMMON.has(name);

/** A highlighter that registers nothing, to prove the alias path is still gated. */
const registersNothing = (): boolean => false;

describe('resolveLanguage', () => {
  it('returns null when the fence carried no language', () => {
    expect(resolveLanguage(undefined, registered)).toBeNull();
    expect(resolveLanguage('', registered)).toBeNull();
    expect(resolveLanguage('   ', registered)).toBeNull();
  });

  it('passes a registered language through', () => {
    expect(resolveLanguage('typescript', registered)).toBe('typescript');
    expect(resolveLanguage('python', registered)).toBe('python');
  });

  it('normalises case and surrounding space', () => {
    expect(resolveLanguage('TypeScript', registered)).toBe('typescript');
    expect(resolveLanguage('  Rust  ', registered)).toBe('rust');
  });

  it("prefers the highlighter's own alias over ours", () => {
    // Prism registers `js`, so we must not rewrite it to `javascript` — the day
    // a bundle ships a distinct grammar for a label, that grammar should win.
    expect(resolveLanguage('js', registered)).toBe('js');
    expect(resolveLanguage('py', registered)).toBe('py');
  });

  it('maps the labels Prism does not register', () => {
    expect(resolveLanguage('zsh', registered)).toBe('bash');
    expect(resolveLanguage('console', registered)).toBe('bash');
    expect(resolveLanguage('tsx', registered)).toBe('typescript');
    expect(resolveLanguage('jsx', registered)).toBe('javascript');
    expect(resolveLanguage('golang', registered)).toBe('go');
    expect(resolveLanguage('c++', registered)).toBe('cpp');
    expect(resolveLanguage('c#', registered)).toBe('csharp');
    expect(resolveLanguage('objc', registered)).toBe('objectivec');
    expect(resolveLanguage('vue', registered)).toBe('markup');
    expect(resolveLanguage('toml', registered)).toBe('ini');
    expect(resolveLanguage('patch', registered)).toBe('diff');
  });

  it('refuses to highlight output and prose', () => {
    // A stack trace coloured as code reads as a rendering bug.
    for (const label of ['text', 'txt', 'plain', 'plaintext', 'none', 'output', 'log', 'csv']) {
      expect(resolveLanguage(label, registered)).toBeNull();
    }
  });

  it('returns null for a language the highlighter does not have', () => {
    expect(resolveLanguage('haskell', registered)).toBeNull();
    expect(resolveLanguage('dockerfile', registered)).toBeNull();
    expect(resolveLanguage('nosuchlanguage', registered)).toBeNull();
  });

  it('never returns a name the highlighter would reject', () => {
    // The contract that keeps `highlight()` from throwing: whatever comes back
    // answered true. Checked against a highlighter that knows nothing.
    for (const label of ['zsh', 'tsx', 'c++', 'typescript', 'js', 'toml']) {
      expect(resolveLanguage(label, registersNothing)).toBeNull();
    }
  });

  it('rejects a label that is a path or otherwise not a grammar name', () => {
    // `registered` throws on the wrong shape, and a fence info string is free text.
    for (const label of ['../etc/passwd', 'a b', 'lang/js', 'x\ny', '{}', 'title="x"']) {
      expect(resolveLanguage(label, registered)).toBeNull();
    }
  });

  it('survives hostile fence labels without throwing', () => {
    for (const label of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(() => resolveLanguage(label, registered)).not.toThrow();
      expect(resolveLanguage(label, registered)).toBeNull();
    }
  });
});

describe('shouldHighlight', () => {
  it('is false without a language', () => {
    expect(shouldHighlight('const a = 1', null)).toBe(false);
  });

  it('is true for an ordinary block', () => {
    expect(shouldHighlight('const a = 1', 'typescript')).toBe(true);
  });

  it('is false once the block is too big to be worth colouring', () => {
    expect(shouldHighlight('x'.repeat(MAX_HIGHLIGHT_CHARS), 'typescript')).toBe(true);
    expect(shouldHighlight('x'.repeat(MAX_HIGHLIGHT_CHARS + 1), 'typescript')).toBe(false);
  });
});
