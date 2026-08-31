/**
 * The one thing a constant for the app's name cannot enforce on its own.
 *
 * `app.json` is read by the native build, not by the bundler, so it holds its own
 * copy of the name and nothing in the type system connects the two. This test is
 * that connection: rename in one place, and the other fails here rather than on a
 * user's launcher.
 */

import app from '../../app.json';

import { APP_NAME, APP_WIRE_NAME } from '@/lib/app';

describe('the app name', () => {
  it('matches the name the native build ships', () => {
    expect(app.expo.name).toBe(APP_NAME);
  });

  it('is what files and client registrations are signed with', () => {
    // Not a tautology worth deleting: these are separately declared on purpose, and
    // this is the line that has to be edited — deliberately — to diverge them.
    expect(APP_WIRE_NAME).toBe(APP_NAME);
  });

  it('leaves identity alone', () => {
    // The slug, the package and the scheme are not presentation. Changing the
    // package makes a new app; changing the scheme invalidates every OAuth redirect
    // an MCP server has already registered.
    expect(app.expo.slug).toBe('agentrouter-mobile');
    expect(app.expo.scheme).toBe('jarvis');
    expect(app.expo.android.package).toBe('org.lyric.agentrouter');
  });

  it('asks for the microphone only because dictation uses it', () => {
    // A permission with no feature behind it is a store-review finding. If voice
    // input is ever removed, this test is what says the permission goes with it.
    const declared: readonly string[] = app.expo.android.permissions;
    const plugins = app.expo.plugins.map((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin));
    expect(declared).toContain('android.permission.RECORD_AUDIO');
    expect(plugins).toContain('expo-speech-recognition');
  });
});
