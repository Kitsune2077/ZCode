#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "../../../scripts/spawn-command.mjs";
import { loadBuiltinProviderConfig } from "../../../scripts/builtin-provider-config.mjs";
import { resolveDesktopProductIdentity } from "./desktop-product-identity.mjs";
import { getTargetPlatform } from "./target-platform.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const workspaceRoot = resolve(desktopRoot, "../..");
const projectPath = resolve(desktopRoot, "native/windows-uninstaller/ZCodeUninstaller.csproj");
const target = getTargetPlatform();

if (target.os !== "win32") {
  console.log("[windows-uninstaller] skip: target is not Windows");
  process.exit(0);
}

const outputDir = resolve(desktopRoot, `bundled-tools/${target.key}/uninstaller`);
const outputPath = resolve(outputDir, "ZCodeUninstall.exe");
const appVersion = JSON.parse(readFileSync(resolve(workspaceRoot, "package.json"), "utf8")).version;
const buildCommit = (
  process.env.ZCODE_COMMIT ??
  execFileSync("git", ["rev-parse", "--short=8", "HEAD"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  })
).trim();
const fileVersionParts = appVersion.split("-", 1)[0].split(".");
while (fileVersionParts.length < 4) fileVersionParts.push("0");

if (
  !/^\d+(?:\.\d+){2}(?:-[0-9A-Za-z.-]+)?$/.test(appVersion) ||
  !/^[0-9A-Za-z.-]+$/.test(buildCommit) ||
  fileVersionParts.some((part) => !/^\d+$/.test(part))
) {
  throw new Error("Invalid Windows uninstaller build identity");
}

const builtinProviderConfig = await loadBuiltinProviderConfig();
const identity = resolveDesktopProductIdentity({
  ...process.env,
  ZCODE_ENV: builtinProviderConfig.environment,
});
const dotnet = process.env.DOTNET_HOST_PATH?.trim() || "dotnet";

mkdirSync(outputDir, { recursive: true });
rmSync(outputPath, { force: true });

try {
  runCommand(
    dotnet,
    [
      "build",
      projectPath,
      "-c",
      "Release",
      "-o",
      outputDir,
      "-nologo",
      "-v:minimal",
      `/p:Version=${appVersion}`,
      `/p:FileVersion=${fileVersionParts.slice(0, 4).join(".")}`,
      `/p:InformationalVersion=${appVersion}|${buildCommit}`,
      `/p:Product=${identity.productName}`,
      `/p:AssemblyTitle=${identity.productName} Uninstaller`,
      "/p:Company=ZCode",
    ],
    {
      cwd: desktopRoot,
      env: process.env,
    },
  );
} catch (error) {
  if (error?.code === "ENOENT" || error?.cause?.code === "ENOENT") {
    throw new Error(
      "dotnet SDK not found; install .NET SDK (net48 reference assemblies are restored from NuGet) before building the Windows uninstaller",
    );
  }
  throw error;
}

if (!existsSync(outputPath)) {
  throw new Error(`Windows uninstaller was not produced: ${outputPath}`);
}

const content = readFileSync(outputPath);
if (content[0] !== 0x4d || content[1] !== 0x5a) {
  throw new Error(`Windows uninstaller is not a PE file: ${outputPath}`);
}
const peOffset = content.readUInt32LE(0x3c);
if (
  peOffset + 4 > content.length ||
  content[peOffset] !== 0x50 ||
  content[peOffset + 1] !== 0x45 ||
  content[peOffset + 2] !== 0x00 ||
  content[peOffset + 3] !== 0x00
) {
  throw new Error(`Windows uninstaller has an invalid PE header: ${outputPath}`);
}

for (const stale of [".pdb", ".exe.config", ".xml"]) {
  rmSync(outputPath.replace(/\.exe$/i, stale), { force: true });
}

console.log(`[windows-uninstaller] built ${outputPath} (${identity.productName} ${appVersion})`);
