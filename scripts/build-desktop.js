#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('🚀 Starting desktop app build...');

// 1. Build the web app
console.log('📦 Building web app...');
execSync('npm run build', { stdio: 'inherit' });

// 2. Electron sources are committed under electron/ (main.js, preload.js, mcpLocalServer.js).
// Do NOT overwrite them with a generated shell — MCP + preload require first-class sources.
const electronDir = path.join(__dirname, '../electron');
const required = ['main.js', 'preload.js', 'mcpLocalServer.js', 'desktopPrefs.js', 'package.json'];
for (const file of required) {
  const p = path.join(electronDir, file);
  if (!fs.existsSync(p)) {
    console.error(`❌ Missing required Electron file: electron/${file}`);
    process.exit(1);
  }
}
// Tray icons (#345) ship inside electron/assets (covered by electron-builder `electron/**`).
// trayTemplate*.png: macOS menu bar template image; tray-black/white*.png: themed monochrome
// for Windows/Linux taskbars; tray-16/32.png: legacy color fallback.
for (const icon of [
  'trayTemplate.png',
  'trayTemplate@2x.png',
  'tray-black.png',
  'tray-black@2x.png',
  'tray-white.png',
  'tray-white@2x.png',
  'tray-16.png',
  'tray-32.png',
]) {
  const p = path.join(electronDir, 'assets', icon);
  if (!fs.existsSync(p)) {
    console.error(`❌ Missing required tray icon: electron/assets/${icon}`);
    process.exit(1);
  }
}
console.log('⚡ Using committed electron/ sources (including MCP and preload)');

// 2.5 Build resource icons (same as the CI "Prepare build resources" step;
// electron-builder converts PNGs to .ico/.icns automatically).
const buildDir = path.join(__dirname, '../build');
fs.mkdirSync(buildDir, { recursive: true });
const iconSource = path.join(__dirname, '../assets/icon.png');
if (!fs.existsSync(iconSource)) {
  console.error('❌ Missing source icon: assets/icon.png');
  process.exit(1);
}
fs.copyFileSync(iconSource, path.join(buildDir, 'icon.png'));
fs.copyFileSync(iconSource, path.join(buildDir, 'icon-512x512.png'));

// 3. electron / electron-builder are pinned in devDependencies (shared with CI via
// the electron-builder.yml config); just confirm the toolchain is ready.
if (!fs.existsSync(path.join(__dirname, '../node_modules/electron-builder/package.json'))) {
  console.error('❌ electron-builder is missing; run npm ci first');
  process.exit(1);
}

// 4. Build the app
console.log('🔨 Building desktop app...');
try {
  execSync('npx electron-builder --publish=never', { stdio: 'inherit' });
  console.log('✅ Desktop app build complete!');
  console.log('📁 Build output is in the release/ directory');
} catch (error) {
  console.error('Build failed:', error.message);
  process.exit(1);
}
