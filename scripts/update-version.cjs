#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PACKAGE_PATH = path.join(PROJECT_ROOT, 'package.json');
const LOCKFILE_PATH = path.join(PROJECT_ROOT, 'package-lock.json');
const SERVER_PACKAGE_PATH = path.join(PROJECT_ROOT, 'server/package.json');
const SERVER_LOCKFILE_PATH = path.join(PROJECT_ROOT, 'server/package-lock.json');
const VERSION_XML_PATH = path.join(PROJECT_ROOT, 'versions/version-info.xml');
const RELEASE_LOCK_PATH = path.join(PROJECT_ROOT, '.release-version.lock');
const RELEASE_LOCK_TAKENOVER_PATH = path.join(PROJECT_ROOT, '.release-version.lock.takenover');
const PACKAGE_SYNC_TRANSACTION = 'package-version-sync';
const PACKAGE_SYNC_JOURNAL_PATH = path.join(PROJECT_ROOT, '.package-sync.transaction.json');
const PACKAGE_SYNC_BACKUP_DIR = path.join(PROJECT_ROOT, '.package-sync-backups');
const PACKAGE_SYNC_TARGETS = [
  { name: 'package-lock.json', path: LOCKFILE_PATH },
  { name: 'server/package.json', path: SERVER_PACKAGE_PATH },
  { name: 'server/package-lock.json', path: SERVER_LOCKFILE_PATH },
];

/**
 * The root package.json is the single source of truth for the app version.
 *
 * Usage:
 *   node scripts/update-version.cjs <changelog...> [--url=downloadUrl]
 *   node scripts/update-version.cjs --sync-lock
 *   node scripts/update-version.cjs --list
 *   node scripts/update-version.cjs --current
 */
function updateVersionInfo() {
  const args = process.argv.slice(2);

  if (args.length === 1) {
    if (args[0] === '--list') {
      listVersions();
      return;
    }
    if (args[0] === '--current') {
      showCurrentVersion();
      return;
    }
    if (args[0] === '--sync-lock') {
      syncLockfileFromRootVersion();
      return;
    }
    if (args[0] === '--help' || args[0] === '-h') {
      showHelp();
      return;
    }
  }

  if (args.length === 0) {
    console.error('❌ Not enough arguments');
    showHelp();
    process.exitCode = 1;
    return;
  }

  let releaseLock;
  let stagedLockfilePath;
  let stagedServerPackagePath;
  let stagedServerLockfilePath;
  let stagedXmlPath;
  let packageTransaction;
  let packageSnapshots;
  let packageFilesCommitted = false;

  try {
    releaseLock = acquireReleaseLockAfterRecovery();
    const releaseArgs = parseReleaseArgs(args);
    if (releaseArgs.changelog.length === 0) {
      throw new Error('At least one changelog entry is required');
    }

    const version = readRootPackageVersion();
    validateVersion(version);
    const xmlContext = loadVersionXml(version);
    stagedLockfilePath = stageSyncedPackageLock(LOCKFILE_PATH, version);
    stagedServerPackagePath = stageSyncedServerPackage(version);
    stagedServerLockfilePath = stageSyncedPackageLock(SERVER_LOCKFILE_PATH, version);
    stagedXmlPath = stageVersionXml(xmlContext, version, releaseArgs.changelog, releaseArgs.customDownloadUrl);
    packageSnapshots = createFileSnapshots(PACKAGE_SYNC_TARGETS.map(({ path: targetPath }) => targetPath));
    packageTransaction = createPackageSyncTransaction(version);

    try {
      commitPackageSyncTargets(version, packageTransaction, {
        stagedLockfilePath,
        stagedServerPackagePath,
        stagedServerLockfilePath,
      });
      packageFilesCommitted = true;
      packageTransaction = null;
      fs.renameSync(stagedXmlPath, VERSION_XML_PATH);
      stagedXmlPath = null;
    } catch (error) {
      try {
        if (packageTransaction?.state === 'prepared') {
          rollbackPackageSyncTransaction(packageTransaction, packageSnapshots);
        } else if (!packageTransaction && packageFilesCommitted) {
          restoreFileSnapshots(packageSnapshots);
        }
      } catch (rollbackError) {
        throw new Error(`${error.message}; ${rollbackError.message}`);
      }
      throw error;
    }

    console.log(`✅ Updated release metadata from root package.json version v${version}`);
    console.log('📝 Changes:');
    releaseArgs.changelog.forEach((item, index) => {
      console.log(`   ${index + 1}. ${item}`);
    });
    if (releaseArgs.customDownloadUrl !== null) {
      console.log(`🔗 Custom download URL: ${releaseArgs.customDownloadUrl}`);
    }
    console.log('\n🔄 Remember to commit these changes to the Git repository');
  } catch (error) {
    console.error('❌ Failed to update version:', error.message);
    process.exitCode = 1;
  } finally {
    cleanupStagedFile(stagedLockfilePath);
    cleanupStagedFile(stagedServerPackagePath);
    cleanupStagedFile(stagedServerLockfilePath);
    cleanupStagedFile(stagedXmlPath);
    releaseReleaseLock(releaseLock);
  }
}

function syncLockfileFromRootVersion() {
  let releaseLock;
  let packageTransaction;
  let packageSnapshots;

  try {
    releaseLock = acquireReleaseLockAfterRecovery();
    const version = readRootPackageVersion();
    validateVersion(version);
    packageSnapshots = createFileSnapshots(PACKAGE_SYNC_TARGETS.map(({ path: targetPath }) => targetPath));
    packageTransaction = createPackageSyncTransaction(version);
    try {
      commitPackageSyncTargets(version, packageTransaction);
      packageTransaction = null;
    } catch (error) {
      try {
        if (packageTransaction?.state === 'prepared') {
          rollbackPackageSyncTransaction(packageTransaction, packageSnapshots);
        }
      } catch (rollbackError) {
        throw new Error(`${error.message}; ${rollbackError.message}`);
      }
      throw error;
    }
    console.log(`📦 Synced root and server package-lock.json to root package.json version v${version}`);
  } catch (error) {
    console.error('❌ Failed to sync package-lock.json:', error.message);
    process.exitCode = 1;
  } finally {
    releaseReleaseLock(releaseLock);
  }
}

function acquireReleaseLockAfterRecovery() {
  const lock = acquireReleaseLockWithTakeover();
  // Recovery must happen after acquiring the exclusive lock; otherwise two processes could recover the same transaction journal concurrently:
  // one is still reading the backups while the other has already deleted them.
  recoverInterruptedPackageSync();
  return lock;
}

function acquireReleaseLockWithTakeover() {
  // Only locks left behind by a dead owner are taken over; if the owner is alive or its state is unknown, acquisition keeps failing (EEXIST rejection).
  tryTakeOverStaleReleaseLock();
  return acquireReleaseLock();
}

function tryTakeOverStaleReleaseLock() {
  const stalePid = readReleaseLockPid(RELEASE_LOCK_PATH);
  if (stalePid === null || getProcessState(stalePid) !== 'dead') {
    return false;
  }

  try {
    // The rename takeover is atomic: only one of the concurrent takers can move the stale lock away
    fs.renameSync(RELEASE_LOCK_PATH, RELEASE_LOCK_TAKENOVER_PATH);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return true;
    }
    throw error;
  }

  if (readReleaseLockPid(RELEASE_LOCK_TAKENOVER_PATH) !== stalePid) {
    // The lock may have been recreated by a live owner before the rename: put it back as-is and give up the takeover; never delete a live process's lock
    try {
      fs.renameSync(RELEASE_LOCK_TAKENOVER_PATH, RELEASE_LOCK_PATH);
    } catch {
      // Give up as well if it cannot be put back; the owner's own release logic is the fallback
    }
    return false;
  }

  unlinkIfExists(RELEASE_LOCK_TAKENOVER_PATH);
  return true;
}

function readReleaseLockPid(lockPath) {
  try {
    const pid = JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid;
    return Number.isSafeInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

function commitPackageSyncTargets(version, transaction, staged = {}) {
  const stagedPaths = {
    lockfile: staged.stagedLockfilePath || null,
    serverPackage: staged.stagedServerPackagePath || null,
    serverLockfile: staged.stagedServerLockfilePath || null,
  };

  try {
    stagedPaths.lockfile ||= stageSyncedPackageLock(LOCKFILE_PATH, version);
    stagedPaths.serverPackage ||= stageSyncedServerPackage(version);
    stagedPaths.serverLockfile ||= stageSyncedPackageLock(SERVER_LOCKFILE_PATH, version);

    fs.renameSync(stagedPaths.lockfile, LOCKFILE_PATH);
    fs.renameSync(stagedPaths.serverPackage, SERVER_PACKAGE_PATH);
    fs.renameSync(stagedPaths.serverLockfile, SERVER_LOCKFILE_PATH);
    for (const target of PACKAGE_SYNC_TARGETS) {
      syncDirectory(path.dirname(target.path));
    }
    verifyRootVersionSync(version);
    markPackageSyncState(transaction, 'committed');
    cleanupPackageSyncTransaction(transaction);
  } finally {
    cleanupStagedFile(stagedPaths.lockfile);
    cleanupStagedFile(stagedPaths.serverPackage);
    cleanupStagedFile(stagedPaths.serverLockfile);
  }
}

function createPackageSyncTransaction(version) {
  if (fs.existsSync(PACKAGE_SYNC_JOURNAL_PATH)) {
    throw new Error('Detected an unfinished package version sync transaction; cannot start a new transaction');
  }

  preparePackageSyncBackupDir();
  const targets = PACKAGE_SYNC_TARGETS.map((target, index) => ({
    targetPath: target.path,
    backupPath: path.join(PACKAGE_SYNC_BACKUP_DIR, `${index}-${path.basename(target.path)}.bak`),
  }));

  try {
    for (const target of targets) {
      writeDurableFile(target.backupPath, fs.readFileSync(target.targetPath));
    }

    const transaction = {
      transaction: PACKAGE_SYNC_TRANSACTION,
      version,
      targets,
      startedAt: new Date().toISOString(),
      state: 'prepared',
    };
    writeDurableJson(PACKAGE_SYNC_JOURNAL_PATH, transaction);
    return transaction;
  } catch (error) {
    cleanupUncommittedPackageSyncArtifacts(targets);
    throw error;
  }
}

function preparePackageSyncBackupDir() {
  if (fs.existsSync(PACKAGE_SYNC_BACKUP_DIR)) {
    if (!fs.statSync(PACKAGE_SYNC_BACKUP_DIR).isDirectory()) {
      throw new Error('The package sync backup path is not a directory; cannot start a new transaction');
    }
    // The transaction journal is written only after all backups are written: when there is no journal, any backups in the directory must come from
    // a sync interrupted before the journal was written; the target files have not been rewritten and nothing references the backups, so they can be safely removed.
    for (const entry of fs.readdirSync(PACKAGE_SYNC_BACKUP_DIR)) {
      const entryPath = path.join(PACKAGE_SYNC_BACKUP_DIR, entry);
      if (!fs.statSync(entryPath).isFile()) {
        throw new Error(`The package sync backup directory contains an entry that cannot be cleaned up: ${entry}`);
      }
      unlinkIfExists(entryPath);
    }
    fs.rmdirSync(PACKAGE_SYNC_BACKUP_DIR);
  }
  fs.mkdirSync(PACKAGE_SYNC_BACKUP_DIR, { mode: 0o700 });
}

function recoverInterruptedPackageSync() {
  const transaction = readPackageSyncJournal();
  if (!transaction) {
    return;
  }

  if (transaction.state === 'prepared') {
    restorePackageSyncBackups(transaction);
    markPackageSyncState(transaction, 'recovered');
  }

  cleanupPackageSyncTransaction(transaction);
}

function readPackageSyncJournal() {
  if (!fs.existsSync(PACKAGE_SYNC_JOURNAL_PATH)) {
    return null;
  }

  let transaction;
  try {
    transaction = JSON.parse(fs.readFileSync(PACKAGE_SYNC_JOURNAL_PATH, 'utf8'));
  } catch (error) {
    throw new Error(packageSyncJournalError(`Failed to read the package sync transaction journal: ${error.message}`));
  }

  validatePackageSyncJournal(transaction);
  return transaction;
}

function packageSyncJournalError(message) {
  return `${message}. If you are sure no sync is in progress, manually delete .package-sync.transaction.json and .package-sync-backups/ and retry`;
}

function validatePackageSyncJournal(transaction) {
  if (!transaction || transaction.transaction !== PACKAGE_SYNC_TRANSACTION) {
    throw new Error(packageSyncJournalError('The package sync transaction journal has an invalid type'));
  }
  if (typeof transaction.version !== 'string') {
    throw new Error(packageSyncJournalError('The package sync transaction journal has an invalid version field'));
  }
  validateVersion(transaction.version);
  if (typeof transaction.startedAt !== 'string' || transaction.startedAt.length === 0) {
    throw new Error(packageSyncJournalError('The package sync transaction journal has an invalid startedAt field'));
  }
  if (!['prepared', 'committed', 'recovered'].includes(transaction.state)) {
    throw new Error(packageSyncJournalError('The package sync transaction journal has an invalid state field'));
  }
  if (!Array.isArray(transaction.targets) || transaction.targets.length !== PACKAGE_SYNC_TARGETS.length) {
    throw new Error(packageSyncJournalError('The package sync transaction journal has an invalid targets list'));
  }

  PACKAGE_SYNC_TARGETS.forEach((expected, index) => {
    const actual = transaction.targets[index];
    const expectedBackupPath = path.join(
      PACKAGE_SYNC_BACKUP_DIR,
      `${index}-${path.basename(expected.path)}.bak`
    );
    if (!actual || actual.targetPath !== expected.path || actual.backupPath !== expectedBackupPath) {
      throw new Error(packageSyncJournalError(`The package sync transaction journal target ${index} does not match what was expected`));
    }
  });
}

function restorePackageSyncBackups(transaction) {
  for (const target of transaction.targets) {
    if (!fs.existsSync(target.backupPath)) {
      throw new Error(
        `Package sync backup file missing: ${path.basename(target.backupPath)}; cannot recover the interrupted transaction.` +
        'You can delete .package-sync.transaction.json and .package-sync-backups/, restore the target files with git, and retry'
      );
    }
    writeDurableFile(target.targetPath, fs.readFileSync(target.backupPath));
  }
}

function markPackageSyncState(transaction, state) {
  const updated = { ...transaction, state };
  writeDurableJson(PACKAGE_SYNC_JOURNAL_PATH, updated);
  Object.assign(transaction, updated);
}

function cleanupPackageSyncTransaction(transaction) {
  for (const target of transaction.targets) {
    unlinkIfExists(target.backupPath);
  }

  if (fs.existsSync(PACKAGE_SYNC_BACKUP_DIR)) {
    if (fs.readdirSync(PACKAGE_SYNC_BACKUP_DIR).length > 0) {
      throw new Error('Package sync backup directory cleanup incomplete; leftover files remain');
    }
    syncDirectory(PACKAGE_SYNC_BACKUP_DIR);
    fs.rmdirSync(PACKAGE_SYNC_BACKUP_DIR);
    syncDirectory(PROJECT_ROOT);
  }

  unlinkIfExists(PACKAGE_SYNC_JOURNAL_PATH);
  syncDirectory(PROJECT_ROOT);
}

function cleanupUncommittedPackageSyncArtifacts(targets) {
  for (const target of targets) {
    unlinkIfExists(target.backupPath);
  }
  if (fs.existsSync(PACKAGE_SYNC_BACKUP_DIR) && fs.readdirSync(PACKAGE_SYNC_BACKUP_DIR).length === 0) {
    fs.rmdirSync(PACKAGE_SYNC_BACKUP_DIR);
  }
  unlinkIfExists(PACKAGE_SYNC_JOURNAL_PATH);
}

function rollbackPackageSyncTransaction(transaction, snapshots) {
  restoreFileSnapshots(snapshots);
  markPackageSyncState(transaction, 'recovered');
  cleanupPackageSyncTransaction(transaction);
}

function getProcessState(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return 'unknown';
  }

  try {
    process.kill(pid, 0);
    return 'live';
  } catch (error) {
    if (error.code === 'ESRCH') {
      return 'dead';
    }
    if (error.code === 'EPERM') {
      return 'live';
    }
    return 'unknown';
  }
}

function writeDurableJson(filePath, value) {
  writeDurableFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeDurableFile(filePath, content) {
  const stagedPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.durable.tmp`
  );
  let fileDescriptor;
  try {
    fileDescriptor = fs.openSync(stagedPath, 'wx', 0o600);
    fs.writeFileSync(fileDescriptor, content);
    fs.fsyncSync(fileDescriptor);
    fs.closeSync(fileDescriptor);
    fileDescriptor = undefined;
    fs.renameSync(stagedPath, filePath);
    syncDirectory(path.dirname(filePath));
  } finally {
    if (fileDescriptor !== undefined) {
      try {
        fs.closeSync(fileDescriptor);
      } catch {
        // Preserve the original write/rename error.
      }
    }
    unlinkIfExists(stagedPath);
  }
}

function syncDirectory(directoryPath) {
  try {
    const fileDescriptor = fs.openSync(directoryPath, 'r');
    try {
      fs.fsyncSync(fileDescriptor);
    } finally {
      fs.closeSync(fileDescriptor);
    }
  } catch (error) {
    if (['EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM'].includes(error.code)) {
      return;
    }
    throw error;
  }
}

function unlinkIfExists(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

function acquireReleaseLock() {
  try {
    fs.writeFileSync(
      RELEASE_LOCK_PATH,
      `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 }
    );
    return RELEASE_LOCK_PATH;
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`Detected another version sync task running (${path.basename(RELEASE_LOCK_PATH)}). Retry after confirming it has finished`);
    }
    throw error;
  }
}

function releaseReleaseLock(lockPath) {
  if (!lockPath) {
    return;
  }

  try {
    fs.unlinkSync(lockPath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`❌ Failed to remove version sync lock ${path.basename(lockPath)}:`, error.message);
      process.exitCode = 1;
    }
  }
}

function parseReleaseArgs(args) {
  let customDownloadUrl = null;
  let hasCustomDownloadUrl = false;
  const changelog = [];

  for (const arg of args) {
    if (arg.startsWith('--url=')) {
      customDownloadUrl = arg.substring(6);
      hasCustomDownloadUrl = true;
    } else {
      changelog.push(arg);
    }
  }

  if (hasCustomDownloadUrl) {
    let url;
    try {
      url = new URL(customDownloadUrl);
    } catch {
      throw new Error('The custom download URL must be a valid absolute URL');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('The custom download URL may only use the http or https protocol');
    }
  }

  return { changelog, customDownloadUrl };
}

function readRootPackageVersion() {
  const packageJson = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
  return packageJson.version;
}

function validateVersion(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`The root package.json version is invalid: ${version}`);
  }
}

function loadVersionXml(version) {
  let xmlContent;
  try {
    fs.accessSync(VERSION_XML_PATH, fs.constants.W_OK);
    xmlContent = fs.readFileSync(VERSION_XML_PATH, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    fs.accessSync(path.dirname(VERSION_XML_PATH), fs.constants.W_OK);
    xmlContent = '<?xml version="1.0" encoding="UTF-8"?>\n<versions>\n</versions>\n';
  }

  const closingTagIndex = xmlContent.lastIndexOf('</versions>');
  if (closingTagIndex === -1) {
    throw new Error('versions/version-info.xml is missing the closing </versions> tag');
  }

  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const versionPattern = new RegExp(`<number>\\s*${escapedVersion}\\s*</number>`);
  if (versionPattern.test(xmlContent)) {
    throw new Error(`Version ${version} already exists in versions/version-info.xml; refusing to publish a duplicate`);
  }

  return { content: xmlContent, closingTagIndex };
}

function stageSyncedPackageLock(lockfilePath, version) {
  const packageLock = JSON.parse(fs.readFileSync(lockfilePath, 'utf8'));
  if (!packageLock.packages || !packageLock.packages['']) {
    throw new Error(`${path.basename(lockfilePath)} is missing the root package entry; cannot sync the version`);
  }

  packageLock.version = version;
  packageLock.packages[''].version = version;
  return stageFile(lockfilePath, `${JSON.stringify(packageLock, null, 2)}\n`);
}

function stageSyncedServerPackage(version) {
  const packageJson = JSON.parse(fs.readFileSync(SERVER_PACKAGE_PATH, 'utf8'));
  packageJson.version = version;
  return stageFile(SERVER_PACKAGE_PATH, `${JSON.stringify(packageJson, null, 2)}\n`);
}

function stageVersionXml(xmlContext, version, changelog, customDownloadUrl) {
  const currentDate = new Date().toISOString().split('T')[0];
  const downloadUrl = customDownloadUrl === null
    ? `https://github.com/AmintaCCCP/GithubStarsManager/releases/download/v${version}/github-stars-manager-${version}.dmg`
    : customDownloadUrl;
  const versionEntry = `  <version>
    <number>${version}</number>
    <releaseDate>${currentDate}</releaseDate>
    <changelog>
${changelog.map((item) => `      <item>${escapeXml(item)}</item>`).join('\n')}
    </changelog>
    <downloadUrl>${escapeXml(downloadUrl)}</downloadUrl>
  </version>\n`;
  const updatedXml = `${xmlContext.content.slice(0, xmlContext.closingTagIndex)}${versionEntry}${xmlContext.content.slice(xmlContext.closingTagIndex)}`;

  return stageFile(VERSION_XML_PATH, updatedXml);
}

function stageFile(targetPath, content) {
  const stagedPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`
  );
  fs.writeFileSync(stagedPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return stagedPath;
}

function cleanupStagedFile(stagedPath) {
  if (!stagedPath || !fs.existsSync(stagedPath)) {
    return;
  }

  try {
    fs.unlinkSync(stagedPath);
  } catch (error) {
    console.error(`❌ Failed to clean up temporary file ${path.basename(stagedPath)}:`, error.message);
    process.exitCode = 1;
  }
}

function createFileSnapshot(filePath) {
  return {
    path: filePath,
    exists: fs.existsSync(filePath),
    content: fs.existsSync(filePath) ? fs.readFileSync(filePath) : null
  };
}

function createFileSnapshots(filePaths) {
  return filePaths.map(createFileSnapshot);
}

function restoreFileSnapshots(snapshots) {
  for (const snapshot of [...snapshots].reverse()) {
    restoreFileSnapshot(snapshot);
  }
}

function restoreFileSnapshot(snapshot) {
  try {
    if (snapshot.exists) {
      fs.writeFileSync(snapshot.path, snapshot.content);
    } else if (fs.existsSync(snapshot.path)) {
      fs.unlinkSync(snapshot.path);
    }
  } catch (error) {
    throw new Error(`Version sync failed, and rollback of ${path.basename(snapshot.path)} did not complete: ${error.message}`);
  }
}

function verifyRootVersionSync(version) {
  const serverPackage = JSON.parse(fs.readFileSync(SERVER_PACKAGE_PATH, 'utf8'));
  const serverPackageLock = JSON.parse(fs.readFileSync(SERVER_LOCKFILE_PATH, 'utf8'));
  const packageLock = JSON.parse(fs.readFileSync(LOCKFILE_PATH, 'utf8'));
  const lockRootVersion = packageLock.packages?.['']?.version;
  const serverLockRootVersion = serverPackageLock.packages?.['']?.version;

  if (readRootPackageVersion() !== version) {
    throw new Error(`The package.json version changed during sync; expected ${version}`);
  }

  if (packageLock.version !== version || lockRootVersion !== version) {
    throw new Error(`The package-lock.json root package version was not synced to ${version}`);
  }

  if (serverPackage.version !== version) {
    throw new Error(`The server/package.json version was not synced to ${version}`);
  }

  if (serverPackageLock.version !== version || serverLockRootVersion !== version) {
    throw new Error(`server/The package-lock.json root package version was not synced to ${version}`);
  }
}

function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function listVersions() {
  try {
    const xmlContent = fs.readFileSync(VERSION_XML_PATH, 'utf8');
    const parser = require('xml2js');

    parser.parseString(xmlContent, (error, result) => {
      if (error) {
        console.error('❌ Failed to parse XML:', error.message);
        process.exitCode = 1;
        return;
      }

      const versions = result.versions?.version || [];
      console.log('📋 Version history:\n');
      versions.forEach((version, index) => {
        console.log(`${index + 1}. v${version.number[0]} (${version.releaseDate[0]})`);
        if (version.changelog?.[0]?.item) {
          version.changelog[0].item.forEach((item) => console.log(`   • ${item}`));
        }
        console.log('');
      });
    });
  } catch (error) {
    console.error('❌ Failed to read version info:', error.message);
    process.exitCode = 1;
  }
}

function showCurrentVersion() {
  try {
    console.log(`📦 Current version: v${readRootPackageVersion()}`);
  } catch (error) {
    console.error('❌ Failed to read current version:', error.message);
    process.exitCode = 1;
  }
}

function showHelp() {
  console.log('📖 Version management tool usage\n');
  console.log('The version in the root package.json is the only version input. Edit it first, then run the commands below.\n');
  console.log('Usage:');
  console.log('  node scripts/update-version.cjs <changelog...> [--url=downloadUrl]');
  console.log('  node scripts/update-version.cjs --sync-lock');
  console.log('  node scripts/update-version.cjs --list');
  console.log('  node scripts/update-version.cjs --current\n');
  console.log('Examples:');
  console.log('  npm run sync-version');
  console.log('  npm run update-version -- "Fix known issues" "Improve user experience"');
  console.log('  npm run update-version -- "Improve performance" --url=https://example.com/download\n');
  console.log('Notes:');
  console.log('  • The root and server package-lock.json files, and the server/package.json version, are synced automatically from the root package.json.');
  console.log('  • electron/package.json does not maintain a separate app version; Electron Builder uses the root package.json.');
  console.log('  • An exclusive repository lock is held during version sync to prevent concurrent releases from overwriting each other.');
  console.log('  • --url= is treated as an invalid argument to avoid silently falling back to the default download URL.');
}

updateVersionInfo();
