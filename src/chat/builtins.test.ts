import {
  BUILTIN_TOOL_NAMES,
  builtinTools,
  capFetched,
  checkFetchUrl,
  CREATE_PDF,
  FETCH_URL,
  htmlToText,
  MAX_FILE_CHARS,
  parsePdf,
  parseWriteFile,
  READ_RESOURCE,
  safeBasename,
  WRITE_FILE,
} from '@/chat/builtins';

describe('safeBasename', () => {
  it('keeps an ordinary name and adds the extension', () => {
    expect(safeBasename('quarterly report', 'md')).toBe('quarterly report.md');
  });

  it('cannot escape the directory', () => {
    // The one property that matters. Every one of these has to land as a plain name.
    for (const attempt of ['../../etc/passwd', '/etc/passwd', 'C:\\Windows\\win.ini', '..\\..\\secrets']) {
      const out = safeBasename(attempt, 'txt');
      expect(out).not.toMatch(/[\\/]/);
      expect(out).not.toContain('..');
    }
  });

  it('replaces an extension the model already added', () => {
    expect(safeBasename('notes.md', 'md')).toBe('notes.md');
    expect(safeBasename('data.csv', 'json')).toBe('data.json');
  });

  it('never produces a hidden file or an empty name', () => {
    expect(safeBasename('.env', 'txt')).toBe('env.txt');
    expect(safeBasename('   ', 'txt')).toBe('file.txt');
    expect(safeBasename('***', 'txt')).toBe('file.txt');
  });

  it('bounds the length', () => {
    expect(safeBasename('a'.repeat(300), 'txt').length).toBeLessThanOrEqual(64);
  });
});

describe('parseWriteFile', () => {
  it('accepts a call and derives the extension from the format', () => {
    expect(parseWriteFile({ name: 'rows', content: 'a,b\n1,2', format: 'csv' })).toEqual({
      ok: true,
      name: 'rows.csv',
      content: 'a,b\n1,2',
    });
  });

  it('falls back to text for a format it does not know', () => {
    const out = parseWriteFile({ name: 'x', content: 'hi', format: 'docx' });
    expect(out).toMatchObject({ ok: true, name: 'x.txt' });
  });

  it('refuses an empty file', () => {
    expect(parseWriteFile({ name: 'x', content: '   ' })).toMatchObject({ ok: false });
    expect(parseWriteFile(null)).toMatchObject({ ok: false });
  });

  it('refuses a file past the ceiling, and says to split it', () => {
    const out = parseWriteFile({ name: 'x', content: 'a'.repeat(MAX_FILE_CHARS + 1) });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain('parts');
  });
});

describe('parsePdf', () => {
  it('titles the document from the filename when no title is given', () => {
    expect(parsePdf({ name: 'Q3 review', markdown: '# hi' })).toEqual({
      ok: true,
      name: 'Q3 review.pdf',
      title: 'Q3 review',
      markdown: '# hi',
    });
  });

  it('prefers an explicit title', () => {
    expect(parsePdf({ name: 'q3', title: 'Q3 Review', markdown: 'x' })).toMatchObject({ title: 'Q3 Review' });
  });

  it('refuses an empty body', () => {
    expect(parsePdf({ name: 'x', markdown: '' })).toMatchObject({ ok: false });
  });
});

describe('checkFetchUrl', () => {
  it('accepts an ordinary page', () => {
    expect(checkFetchUrl('https://example.com/a?b=1')).toEqual({ ok: true, url: 'https://example.com/a?b=1' });
  });

  it('refuses anything that is not http', () => {
    for (const url of ['file:///etc/passwd', 'data:text/html,<b>x', 'jarvis://callback']) {
      expect(checkFetchUrl(url)).toMatchObject({ ok: false });
    }
  });

  it('refuses the local network', () => {
    // The prompt-injection case: a page the model just read tells it to fetch the
    // router's admin panel, from inside the user's own network.
    for (const host of [
      'http://localhost:8080/',
      'http://127.0.0.1/',
      'http://192.168.1.1/admin',
      'http://10.0.0.5/',
      'http://169.254.169.254/latest/meta-data/',
      'http://172.16.0.1/',
      'http://printer.local/',
      'http://[::1]/',
    ]) {
      expect(checkFetchUrl(host)).toMatchObject({ ok: false });
    }
  });

  it('allows a public address that merely looks private', () => {
    expect(checkFetchUrl('http://172.32.0.1/')).toMatchObject({ ok: true });
  });

  it('refuses credentials in the URL', () => {
    expect(checkFetchUrl('https://user:pw@example.com/')).toMatchObject({ ok: false });
  });

  it('refuses what is not a URL at all', () => {
    expect(checkFetchUrl('example.com')).toMatchObject({ ok: false });
    expect(checkFetchUrl(42)).toMatchObject({ ok: false });
  });
});

describe('htmlToText', () => {
  it('drops scripts and styles entirely', () => {
    const text = htmlToText('<style>a{color:red}</style><p>Hello</p><script>evil()</script>');
    expect(text).toBe('Hello');
  });

  it('keeps block structure as newlines', () => {
    expect(htmlToText('<h1>Title</h1><p>One</p><p>Two</p>')).toBe('Title\nOne\nTwo');
  });

  it('marks list items', () => {
    expect(htmlToText('<ul><li>a</li><li>b</li></ul>')).toBe('- a\n- b');
  });

  it('decodes the entities that change meaning', () => {
    expect(htmlToText('<p>a &amp; b &lt;c&gt; &quot;d&quot;</p>')).toBe('a & b <c> "d"');
  });
});

describe('capFetched', () => {
  it('leaves a short page alone', () => {
    expect(capFetched('short', 100)).toBe('short');
  });

  it('says so when it truncates', () => {
    const out = capFetched('a'.repeat(50), 10);
    expect(out.startsWith('a'.repeat(10))).toBe(true);
    expect(out).toContain('Truncated');
  });
});

describe('builtinTools', () => {
  it('always offers the file tools', () => {
    const names = builtinTools({ web: false, resources: [] }).map((tool) => tool.name);
    expect(names).toEqual([WRITE_FILE, CREATE_PDF]);
  });

  it('offers web access only when it is switched on', () => {
    const names = builtinTools({ web: true, resources: [] }).map((tool) => tool.name);
    expect(names).toContain(FETCH_URL);
  });

  it('offers the resource tool only when there is something to read', () => {
    expect(builtinTools({ web: false, resources: [] }).map((t) => t.name)).not.toContain(READ_RESOURCE);
    const withResource = builtinTools({ web: false, resources: ['file:///a'] });
    const tool = withResource.find((candidate) => candidate.name === READ_RESOURCE);
    expect((tool?.inputSchema.properties as Record<string, { enum?: string[] }>).uri?.enum).toEqual(['file:///a']);
  });

  it('declares every name the loop dispatches on', () => {
    // The bug this catches: adding a tool here and forgetting the loop's own list, so
    // the model is offered a tool that comes back "unknown tool".
    const all = builtinTools({ web: true, resources: ['file:///a'] }).map((tool) => tool.name);
    expect([...all].sort()).toEqual([...BUILTIN_TOOL_NAMES].sort());
  });
});
