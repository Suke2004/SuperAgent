import {
  BUILTIN_TOOL_NAMES,
  builtinTools,
  capFetched,
  checkFetchUrl,
  CREATE_DOCUMENT,
  CREATE_PDF,
  FETCH_URL,
  htmlToText,
  MAX_FILE_CHARS,
  parseDocument,
  parsePdf,
  parseWriteFile,
  READ_RESOURCE,
  RUN_CODE,
  safeBasename,
  summariseTools,
  WRITE_FILE,
} from '@/chat/builtins';
import { blockedInPlanMode } from '@/chat/plan';

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

describe('parseDocument', () => {
  it('accepts the three formats and fixes the extension to match', () => {
    expect(parseDocument({ name: 'plan', format: 'docx', markdown: '# hi' })).toEqual({
      ok: true,
      name: 'plan.docx',
      format: 'docx',
      markdown: '# hi',
    });
    expect(parseDocument({ name: 'budget.txt', format: 'XLSX', markdown: 'a' })).toMatchObject({
      name: 'budget.xlsx',
      format: 'xlsx',
    });
    expect(parseDocument({ name: 'deck', format: 'pptx', markdown: 'a' })).toMatchObject({ format: 'pptx' });
  });

  it('defaults to a Word document when the format is missing', () => {
    expect(parseDocument({ name: 'notes', markdown: 'a' })).toMatchObject({ format: 'docx', name: 'notes.docx' });
  });

  // The one that matters: the format decides which writer runs, so an unknown one is
  // refused rather than corrected — writing docx bytes into a file called `.pages`
  // produces something no app will open and no error anyone can act on.
  it('refuses a format it cannot write, and names the ones it can', () => {
    const refused = parseDocument({ name: 'x', format: 'pages', markdown: 'a' });
    expect(refused).toMatchObject({ ok: false });
    if (refused.ok) throw new Error('unreachable');
    expect(refused.reason).toContain('docx, xlsx, pptx');
  });

  it('refuses an empty body', () => {
    expect(parseDocument({ name: 'x', format: 'docx', markdown: '   ' })).toMatchObject({ ok: false });
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
    expect(names).toEqual([WRITE_FILE, CREATE_PDF, CREATE_DOCUMENT]);
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

  it('offers the sandbox only when it is switched on', () => {
    expect(builtinTools({ web: false, resources: [] }).map((t) => t.name)).not.toContain(RUN_CODE);
    expect(builtinTools({ web: false, code: true, resources: [] }).map((t) => t.name)).toContain(RUN_CODE);
  });

  it('declares every name the loop dispatches on', () => {
    // The bug this catches: adding a tool here and forgetting the loop's own list, so
    // the model is offered a tool that comes back "unknown tool".
    const all = builtinTools({ web: true, code: true, resources: ['file:///a'] }).map((tool) => tool.name);
    expect([...all].sort()).toEqual([...BUILTIN_TOOL_NAMES].sort());
  });
});

describe('summariseTools', () => {
  const NONE = { web: false, search: false, code: false, serverTools: 0, servers: 0, skills: 0, plan: false };

  it('names the three that are always there', () => {
    expect(summariseTools(NONE)).toBe('files, PDFs and documents');
  });

  it('adds each switch as it comes on', () => {
    expect(summariseTools({ ...NONE, web: true, search: true, code: true })).toBe(
      'files, PDFs and documents · web pages · web search · code',
    );
  });

  it('counts server tools and the servers they came from', () => {
    expect(summariseTools({ ...NONE, serverTools: 7, servers: 2 })).toContain('7 tools from 2 servers');
    expect(summariseTools({ ...NONE, serverTools: 1, servers: 1 })).toContain('1 tool from 1 server');
  });

  it('counts skills', () => {
    expect(summariseTools({ ...NONE, skills: 1 })).toContain('1 skill');
    expect(summariseTools({ ...NONE, skills: 3 })).toContain('3 skills');
  });

  it('says nothing about servers or skills when there are none', () => {
    expect(summariseTools(NONE)).not.toMatch(/server|skill/);
  });

  it('matches what plan mode actually blocks', () => {
    // The tripwire. `plan.ts` owns the gate and cannot be imported by `builtins.ts`,
    // so if the split below ever moves, these words have to move with it.
    expect([WRITE_FILE, CREATE_PDF, CREATE_DOCUMENT].every(blockedInPlanMode)).toBe(true);
    expect([FETCH_URL, RUN_CODE, READ_RESOURCE].some(blockedInPlanMode)).toBe(false);

    const planning = summariseTools({ ...NONE, web: true, code: true, serverTools: 4, servers: 1, plan: true });
    expect(planning).toContain('writing blocked');
    expect(planning).toContain('4 server tools blocked');
    // The read-only two survive, which is the half a "plan mode is on" badge cannot say.
    expect(planning).toContain('web pages');
    expect(planning).toContain('code');
  });
});
