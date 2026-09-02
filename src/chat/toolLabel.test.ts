import { bareToolName, describeTool, toolDetail } from '@/chat/toolLabel';

describe('bareToolName', () => {
  it('drops an MCP server prefix', () => {
    expect(bareToolName('mcp__filesystem__read_text_file')).toBe('read_text_file');
  });

  it('handles slash- and dot-separated routing', () => {
    expect(bareToolName('github/search_issues')).toBe('search_issues');
    expect(bareToolName('slack.post_message')).toBe('post_message');
  });

  it('leaves a plain name alone', () => {
    expect(bareToolName('write_file')).toBe('write_file');
  });
});

describe('describeTool', () => {
  it('names the builtins', () => {
    expect(describeTool('web_search').label).toBe('Searched the web');
    expect(describeTool('fetch_url').label).toBe('Read a page');
    expect(describeTool('write_file').label).toBe('Wrote a file');
    expect(describeTool('create_pdf').label).toBe('Made a PDF');
    expect(describeTool('create_document').label).toBe('Wrote a file');
    expect(describeTool('run_code').label).toBe('Ran code');
    expect(describeTool('read_mcp_resource').label).toBe('Read a file');
  });

  it('reads the verb through an MCP prefix', () => {
    // The server is called `websearch`, which must not make its file reads look
    // like searches — this is the whole reason the prefix is stripped.
    expect(describeTool('mcp__websearch__read_file').label).toBe('Read a file');
  });

  it('prefers the specific verb over the general one', () => {
    // `read_url` is a fetch, and must be caught before the bare `read`.
    expect(describeTool('read_url').label).toBe('Read a page');
    expect(describeTool('grep_files').label).toBe('Searched the files');
  });

  it('falls back to the tool own name rather than to nothing', () => {
    expect(describeTool('summariseThread').label).toBe('Ran summarise thread');
  });

  it('does not read a verb out of the middle of a word', () => {
    // Every one of these contains a verb as a substring: "thread" holds `read`,
    // "spreadsheet" holds it too, "listen" holds `list`, "download" holds `load`.
    // Substring matching would label all four wrongly and confidently.
    expect(describeTool('summarise_thread').label).toBe('Ran summarise thread');
    expect(describeTool('listen_for_webhook').label).toBe('Ran listen for webhook');
  });

  it('never claims an outcome, even with no input', () => {
    for (const name of ['web_search', 'weird_unknown_thing']) {
      expect(describeTool(name).detail).toBeNull();
    }
  });
});

describe('toolDetail', () => {
  it('picks the query over the url', () => {
    expect(toolDetail({ url: 'https://example.com', query: 'reanimated v4' })).toBe('reanimated v4');
  });

  it('flattens and caps a long argument', () => {
    const detail = toolDetail({ code: `a\n${'x'.repeat(200)}` });
    expect(detail).not.toBeNull();
    expect(detail!.length).toBeLessThanOrEqual(64);
    expect(detail!.endsWith('…')).toBe(true);
    expect(detail).not.toContain('\n');
  });

  it('ignores non-string and blank arguments', () => {
    expect(toolDetail({ path: '   ', limit: 5 })).toBeNull();
    expect(toolDetail({ nested: { path: 'a.ts' } })).toBeNull();
    expect(toolDetail(null)).toBeNull();
    expect(toolDetail(['a.ts'])).toBeNull();
  });

  it('takes a bare string input as the detail', () => {
    expect(toolDetail('src/index.ts')).toBe('src/index.ts');
    expect(toolDetail('  ')).toBeNull();
  });
});
