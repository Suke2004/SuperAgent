/**
 * The URL a hostile app can put in front of this one.
 *
 * `incomingFile` is a trust boundary, so the cases that matter here are the refusals
 * rather than the happy path: a `file://` path pointed at this app's own private
 * storage, and a name with a slash or a `..` in it. Both arrive from outside and both
 * are one branch away from being read into a message the user then sends.
 */

import { incomingFile, nameFromUri } from '@/chat/incoming';

describe('nameFromUri', () => {
  it('decodes the display name a document provider puts in the path', () => {
    expect(nameFromUri('content://com.android.providers.downloads.documents/document/primary%3ADownload%2Freport.pdf')).toBe(
      'report.pdf',
    );
  });

  it('gives nothing back for an opaque id, so the provider is asked instead', () => {
    expect(nameFromUri('content://com.android.providers.downloads.documents/document/msf%3A42')).toBe('');
    expect(nameFromUri('content://media/external/images/media/1234')).toBe('');
  });

  it('drops a query and a fragment before looking for the extension', () => {
    expect(nameFromUri('content://x/y/notes.md?take=1#top')).toBe('notes.md');
  });

  it('keeps no separator, however it was encoded', () => {
    // The name is what types the file and what the composer shows. A slash that
    // survived would be a path, and `..` in a path is how a name becomes a traversal.
    for (const uri of [
      'content://x/y/%2E%2E%2Fetc%2Fpasswd.txt',
      'content://x/y/a%5Cb.txt',
      'content://x/y/primary%3A..%2F..%2Fsecret.txt',
    ]) {
      expect(nameFromUri(uri)).not.toMatch(/[/\\]/);
    }
  });

  it('caps a long name without losing the extension that types it', () => {
    const name = nameFromUri(`content://x/y/${'a'.repeat(400)}.pdf`);
    expect(name.length).toBeLessThanOrEqual(120);
    expect(name.endsWith('.pdf')).toBe(true);
  });
});

describe('incomingFile', () => {
  it('accepts a content URI, which comes with a read grant and cannot name a local path', () => {
    expect(incomingFile('content://x/y/report.pdf')).toEqual({
      kind: 'file',
      uri: 'content://x/y/report.pdf',
      name: 'report.pdf',
    });
  });

  it('refuses a file path, whatever it points at', () => {
    // The reason this branch exists: `file:///data/data/<package>/…` is this app's own
    // private storage, including its database. A crafted VIEW intent must not be able
    // to have the app read that into a message.
    const refused = incomingFile('file:///data/data/org.lyric.agentrouter/databases/chat.db');
    expect(refused.kind).toBe('refused');
    expect(incomingFile('file:///sdcard/Download/report.pdf').kind).toBe('refused');
  });

  it('leaves this app’s own deep links alone, in any case', () => {
    expect(incomingFile('jarvis://new?q=hello')).toEqual({ kind: 'ignored' });
    expect(incomingFile('JARVIS://chat/abc')).toEqual({ kind: 'ignored' });
  });

  it('passes through everything else, so the dev server and http links keep working', () => {
    expect(incomingFile('http://192.168.1.5:8081/').kind).toBe('ignored');
    expect(incomingFile('/chat/abc').kind).toBe('ignored');
    expect(incomingFile('').kind).toBe('ignored');
  });

  it('is not fooled by whitespace or by a scheme in the wrong case', () => {
    expect(incomingFile('  CONTENT://x/y/a.pdf ')).toEqual({
      kind: 'file',
      uri: 'CONTENT://x/y/a.pdf',
      name: 'a.pdf',
    });
    expect(incomingFile('  FILE:///etc/passwd').kind).toBe('refused');
  });
});
