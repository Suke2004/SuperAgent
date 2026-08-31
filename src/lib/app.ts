/**
 * The app's own name, in one place.
 *
 * It was in six: `app.json`, the composer placeholder, two permission strings, the
 * export header, the backup envelope, the MCP OAuth client registration and the
 * lock screen — and they disagreed, so a user could be asked for the camera by
 * "Jarvis", restore a backup written by "AgentRouter Mobile" and read an export
 * signed by a third name. A rename is a one-line change or it is a bug hunt.
 *
 * `app.json` cannot import this (it is JSON read by the native build), so that file
 * is the one remaining copy and the constant is asserted against it in
 * `app.test.ts`.
 *
 * The **slug**, the Android package and the URL scheme are deliberately *not* here.
 * They are identity rather than presentation: changing the package makes a new app
 * that cannot update the old one, and changing the scheme invalidates every OAuth
 * redirect already registered with an MCP server.
 */

/** What the app calls itself to the user. */
export const APP_NAME = 'SuperAgent';

/**
 * The name written into files this app produces — exports, backups — and sent to
 * MCP servers at client registration.
 *
 * The same string today. Kept separate because a display rename is cosmetic and a
 * wire rename is a compatibility event: readers of older files must keep working,
 * which is why `parseBackup` never rejects on this field.
 */
export const APP_WIRE_NAME = APP_NAME;
