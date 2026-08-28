const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
// expo-sqlite's browser worker imports the bundled SQLite binary directly.
// Metro does not include wasm in the default asset extension list.
config.resolver.assetExts.push('wasm');

module.exports = config;
