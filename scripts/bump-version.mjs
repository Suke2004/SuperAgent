#!/usr/bin/env node
/**
 * Version bump script for Jarvis app
 * Usage: node scripts/bump-version.mjs [patch|minor|major]
 *
 * Updates version in:
 *   - package.json
 *   - app.json (expo.version, android.versionCode)
 *
 * Note: android.versionCode is also auto-incremented by EAS on each
 * production build (autoIncrement: true). This script bumps the
 * human-readable semantic version.
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const bumpType = process.argv[2];
if (!['patch', 'minor', 'major'].includes(bumpType)) {
  console.error('Usage: node scripts/bump-version.mjs [patch|minor|major]');
  process.exit(1);
}

// --- Read files ---
const pkgPath = resolve(root, 'package.json');
const appPath = resolve(root, 'app.json');

const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
const app = JSON.parse(readFileSync(appPath, 'utf-8'));

const currentVersion = pkg.version;
const [major, minor, patch] = currentVersion.split('.').map(Number);

// --- Calculate new version ---
let newVersion;
switch (bumpType) {
  case 'major': newVersion = `${major + 1}.0.0`; break;
  case 'minor': newVersion = `${major}.${minor + 1}.0`; break;
  case 'patch': newVersion = `${major}.${minor}.${patch + 1}`; break;
}

// --- New versionCode: encode as MAJOR*10000 + MINOR*100 + PATCH ---
// e.g. 1.2.3 → 10203, 2.0.0 → 20000
const [nMaj, nMin, nPat] = newVersion.split('.').map(Number);
const newVersionCode = nMaj * 10000 + nMin * 100 + nPat;

// --- Apply ---
pkg.version = newVersion;
app.expo.version = newVersion;
app.expo.android.versionCode = newVersionCode;

// --- Write ---
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
writeFileSync(appPath, JSON.stringify(app, null, 2) + '\n');

console.log(`\n✅ Version bumped: ${currentVersion} → ${newVersion}`);
console.log(`   versionCode / buildNumber: ${newVersionCode}`);
console.log(`\nNext steps:`);
console.log(`  git add package.json app.json`);
console.log(`  git commit -m "chore: bump version to ${newVersion}"`);
console.log(`  git tag v${newVersion}`);
console.log(`  git push && git push --tags\n`);
