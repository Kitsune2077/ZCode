#!/usr/bin/env node

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const targetArch = (process.env.ZCODE_TARGET_ARCH ?? process.arch).toLowerCase();
const exePath = resolve(
  desktopRoot,
  `bundled-tools/win32-${targetArch}/uninstaller/ZCodeUninstall.exe`,
);

if (process.platform !== "win32") {
  process.stdout.write("[windows-uninstaller] skipped: Windows only\n");
  process.exit(0);
}

if (!existsSync(exePath)) {
  execFileSync(process.execPath, [resolve(scriptDir, "build-windows-uninstaller.mjs")], {
    cwd: desktopRoot,
    stdio: "inherit",
  });
}

const root = mkdtempSync(join(tmpdir(), "zcode-uninstaller-smoke-"));
const results = [];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function readLog(path) {
  assert(existsSync(path), `log was not created: ${path}`);
  return readFileSync(path, "utf8");
}

function createInstall(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ZCode.exe"), "dummy", "utf8");
  writeFileSync(join(dir, "Uninstall ZCode.exe"), "dummy", "utf8");
  writeFileSync(join(dir, "payload.txt"), "dummy", "utf8");
}

function run(args, options = {}) {
  return spawnSync(exePath, args, {
    cwd: desktopRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsVerbatimArguments: options.verbatim === true,
    env: { ...process.env, ...options.env },
  });
}

function commonArgs(logPath) {
  return [
    "--silent",
    "--no-registry",
    "--no-shortcuts",
    "--no-process-kill",
    "--no-self-delete",
    "--log",
    logPath,
  ];
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

try {
  const versionLog = join(root, "version.log");
  const version = run(["--version", "--log", versionLog]);
  assert(version.status === 0, `--version exited with ${version.status}`);
  assert(readLog(versionLog).includes("ZCODE_UNINSTALLER"), "version marker missing");

  const dryDir = join(root, "dry", "install");
  createInstall(dryDir);
  const dryLog = join(root, "dry.log");
  const dry = run([...commonArgs(dryLog), "--dry-run", "--install-dir", dryDir]);
  assert(dry.status === 0, `dry-run exited with ${dry.status}`);
  assert(existsSync(join(dryDir, "ZCode.exe")), "dry-run deleted ZCode.exe");
  assert(readLog(dryLog).includes("dry-run"), "dry-run marker missing");

  const cleanDir = join(root, "clean", "install");
  createInstall(cleanDir);
  const cleanLog = join(root, "clean.log");
  const clean = run([...commonArgs(cleanLog), "--install-dir", cleanDir]);
  assert(clean.status === 0, `cleanup exited with ${clean.status}`);
  assert(!existsSync(join(cleanDir, "ZCode.exe")), "cleanup left ZCode.exe");
  assert(!existsSync(join(cleanDir, "Uninstall ZCode.exe")), "cleanup left official uninstaller");
  assert(!existsSync(join(cleanDir, "payload.txt")), "cleanup left payload.txt");
  assert(readLog(cleanLog).includes("cleanup-completed"), "cleanup-completed marker missing");

  const portableDir = join(root, "portable");
  mkdirSync(portableDir, { recursive: true });
  writeFileSync(join(portableDir, "payload.txt"), "dummy", "utf8");
  const portableLog = join(root, "portable.log");
  const portable = run([...commonArgs(portableLog), "--install-dir", portableDir]);
  assert(portable.status === 1, `portable guard exited with ${portable.status}`);
  assert(existsSync(join(portableDir, "payload.txt")), "portable guard deleted files");
  assert(readLog(portableLog).includes("reason=portable"), "portable refusal marker missing");

  const home = join(root, "home");
  const appData = join(root, "appdata");
  const dataDir = join(home, ".zcode");
  const appDataDir = join(appData, "ZCode");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(appDataDir, { recursive: true });
  writeFileSync(join(dataDir, "session.txt"), "keep", "utf8");
  writeFileSync(join(appDataDir, "cache.txt"), "keep", "utf8");

  const preserveDir = join(root, "preserve", "install");
  createInstall(preserveDir);
  const preserveLog = join(root, "preserve.log");
  const preserve = run([...commonArgs(preserveLog), "--install-dir", preserveDir]);
  assert(preserve.status === 0, `preserve cleanup exited with ${preserve.status}`);
  assert(existsSync(join(dataDir, "session.txt")), "default cleanup deleted ~/.zcode");
  assert(existsSync(join(appDataDir, "cache.txt")), "default cleanup deleted %APPDATA%\\ZCode");

  const deleteDir = join(root, "delete", "install");
  createInstall(deleteDir);
  const deleteLog = join(root, "delete.log");
  const deleteData = run([
    ...commonArgs(deleteLog),
    "--install-dir",
    deleteDir,
    "--delete-user-data",
    "--profile-dir",
    home,
    "--appdata-dir",
    appData,
  ]);
  assert(deleteData.status === 0, `delete-user-data exited with ${deleteData.status}`);
  assert(!existsSync(dataDir), "delete-user-data left ~/.zcode");
  assert(!existsSync(appDataDir), "delete-user-data left %APPDATA%\\ZCode");

  const spaceDir = join(root, "space dir", "install dir");
  createInstall(spaceDir);
  const spaceLog = join(root, "space.log");
  const space = run([...commonArgs(spaceLog), `_?=${spaceDir}`], { verbatim: true });
  assert(space.status === 0, `unquoted _?= with spaces exited with ${space.status}`);
  assert(!existsSync(join(spaceDir, "ZCode.exe")), "unquoted _?= path was truncated");
  assert(readLog(spaceLog).includes("cleanup-completed"), "space path cleanup marker missing");

  const lockDir = join(root, "locked", "install");
  createInstall(lockDir);
  const lockLog = join(root, "locked.log");
  const lockPath = join(lockDir, "payload.txt");
  const locker = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$f=[IO.File]::Open($env:ZCODE_LOCK,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); Start-Sleep -Seconds 30",
    ],
    {
      env: { ...process.env, ZCODE_LOCK: lockPath },
      stdio: "ignore",
    },
  );
  await sleep(1000);
  const locked = run([...commonArgs(lockLog), "--install-dir", lockDir]);
  locker.kill();
  await Promise.race([new Promise((resolveExit) => locker.once("exit", resolveExit)), sleep(2000)]);
  assert(locked.status === 2, `locked-file cleanup exited with ${locked.status}`);
  assert(readLog(lockLog).includes("file-in-use"), "locked-file failure reason missing");

  results.push(
    "version",
    "dry-run",
    "cleanup",
    "portable",
    "preserve-data",
    "delete-data",
    "space-path",
    "locked-file",
  );
  process.stdout.write(`[windows-uninstaller] passed: ${results.join(", ")}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
