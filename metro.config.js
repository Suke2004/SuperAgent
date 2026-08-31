const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

// expo-sqlite's browser worker imports the bundled SQLite binary directly.
// Metro does not include wasm in the default asset extension list.
config.resolver.assetExts.push('wasm');

// Exclude .claude/worktrees (git worktrees) from Metro's file watcher.
// These directories contain their own node_modules with temp paths that
// don't exist on disk, causing ENOENT watch errors.
const claudeWorktreesPath = path.join(__dirname, '\\.claude');
config.resolver.blockList = [
  new RegExp(`${claudeWorktreesPath.replace(/\\/g, '\\\\')}.*`),
];

module.exports = config;
