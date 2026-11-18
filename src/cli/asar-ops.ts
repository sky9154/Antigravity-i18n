import * as asar from "@electron/asar";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";


export type AsarState = "patched" | "unpatched" | "corrupt";

interface BackupMeta {
  version: string;
  sha256: string;
  backedUpAt: string;
}

const PATCH_MARKER = "/* AGY_I18N_PATCHED */";
const LEGACY_PATCH_MARKER = "/* AGY_ZHTW_PATCHED */";

const STATIC_HTML_TARGETS = [
  "dist/ideInstall/wizardHtml.js",
  "dist/remote/disconnectedPage.js",
  "dist/remote/sshPrompts.js",
  "dist/cablev2.js",
  "dist/provisionSplash.js"
];


function sha256File(filePath: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}


function writeFileAtomically(destPath: string, content: string): void {
  const tmpPath = `${destPath}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmpPath, content, "utf8");
    fs.renameSync(tmpPath, destPath);
  } catch (error) {
    fs.rmSync(tmpPath, { force: true });
    throw error;
  }
}


function copyFileStaged(srcPath: string, destPath: string): void {
  const tmpPath = `${destPath}.tmp.${process.pid}`;
  try {
    fs.copyFileSync(srcPath, tmpPath);
    fs.renameSync(tmpPath, destPath);
  } catch (error) {
    fs.rmSync(tmpPath, { force: true });
    throw error;
  }
}


export function readAppVersion(appDir: string): string {
  const verFile = path.join(appDir, "version");
  return fs.existsSync(verFile) ? fs.readFileSync(verFile, "utf8").trim() : "unknown";
}


export function inspectAsarState(asarPath: string): AsarState {
  if (!fs.existsSync(asarPath)) {
    return "corrupt";
  }

  try {
    asar.uncache(asarPath);
    const entries = asar.listPackage(asarPath, { isPack: false });
    if (entries.length === 0) {
      return "corrupt";
    }

    const buf = asar.extractFile(asarPath, "dist/main.js");
    const mainText = buf.toString("utf8");
    if (!mainText) {
      return "corrupt";
    }

    return mainText.includes(PATCH_MARKER) || mainText.includes(LEGACY_PATCH_MARKER)
      ? "patched"
      : "unpatched";
  } catch {
    return "corrupt";
  }
}


export function isAsarPatched(asarPath: string): boolean {
  return inspectAsarState(asarPath) === "patched";
}


export function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}


export function listRelativeFiles(dir: string, base = dir): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const result: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...listRelativeFiles(full, base));
    } else if (entry.isFile()) {
      result.push(path.relative(base, full));
    }
  }
  return result;
}


export function verifyUnpackedCompleteness(
  origUnpackedDir: string,
  stagedUnpackedDir: string
): void {
  const origFiles = listRelativeFiles(origUnpackedDir);
  if (origFiles.length === 0) {
    return;
  }

  if (!fs.existsSync(stagedUnpackedDir)) {
    throw new Error(
      `Expected repacked unpacked directory not found: ${stagedUnpackedDir}`
    );
  }

  const missing: string[] = [];
  for (const rel of origFiles) {
    const target = path.join(stagedUnpackedDir, rel);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      missing.push(rel);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Repacked app.asar.unpacked missing ${missing.length} file(s), first: ${missing[0]}`
    );
  }
}


export function verifyBackupForRestore(
  appDir: string,
  backupPath: string,
  metaPath: string
): void {
  const backupState = inspectAsarState(backupPath);
  if (backupState !== "unpatched") {
    throw new Error(
      `Backup ${backupPath} is ${backupState} and cannot be used as clean original ASAR.`
    );
  }

  if (!fs.existsSync(metaPath)) {
    return;
  }

  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as BackupMeta;
  const actualHash = sha256File(backupPath);
  if (meta.sha256 && meta.sha256 !== actualHash) {
    throw new Error(
      `Backup integrity check failed for ${backupPath} (sha256 mismatch).`
    );
  }

  const installedVersion = readAppVersion(appDir);
  if (
    meta.version &&
    installedVersion !== "unknown" &&
    meta.version !== installedVersion
  ) {
    throw new Error(
      `Backup version (v${meta.version}) does not match installed version (v${installedVersion}).`
    );
  }
}


export function ensureBackup(
  asarPath: string,
  backupPath: string,
  metaPath: string,
  version: string
): void {
  const state = inspectAsarState(asarPath);
  if (state === "corrupt") {
    throw new Error(
      `Cannot read ${asarPath} (corrupt or invalid archive). Aborting to protect existing backup.`
    );
  }

  const currentHash = sha256File(asarPath);

  if (!fs.existsSync(backupPath)) {
    if (state === "patched") {
      throw new Error("app.asar is already patched, but no app.asar.bak backup was found.");
    }

    copyFileStaged(asarPath, backupPath);
    const meta: BackupMeta = {
      version,
      sha256: currentHash,
      backedUpAt: new Date().toISOString()
    };
    writeFileAtomically(metaPath, JSON.stringify(meta, null, 2));
    console.log(`Created backup: ${backupPath} (v${version})`);
    return;
  }

  const backupState = inspectAsarState(backupPath);
  if (backupState !== "unpatched") {
    if (state === "unpatched") {
      copyFileStaged(asarPath, backupPath);
      const meta: BackupMeta = {
        version,
        sha256: currentHash,
        backedUpAt: new Date().toISOString()
      };
      writeFileAtomically(metaPath, JSON.stringify(meta, null, 2));
      console.log(`Replaced invalid backup from clean app.asar (v${version})`);
      return;
    }

    throw new Error(
      `Existing backup ${backupPath} is ${backupState}. Restore or reinstall Antigravity before continuing.`
    );
  }

  if (state === "unpatched") {
    const prevMeta = fs.existsSync(metaPath)
      ? (JSON.parse(fs.readFileSync(metaPath, "utf8")) as BackupMeta)
      : null;

    if (!prevMeta || prevMeta.sha256 !== currentHash || prevMeta.version !== version) {
      copyFileStaged(asarPath, backupPath);
      const meta: BackupMeta = {
        version,
        sha256: currentHash,
        backedUpAt: new Date().toISOString()
      };
      writeFileAtomically(metaPath, JSON.stringify(meta, null, 2));
      console.log(`Updated backup for unpatched app.asar (v${version})`);
    }
    return;
  }

  verifyBackupForRestore(path.dirname(path.dirname(asarPath)), backupPath, metaPath);
}


export function deployAsarAtomically(
  asarPath: string,
  stagedSourceAsar: string,
  unpackedDir?: string,
  stagedSourceUnpackedDir?: string,
  expectedState: AsarState = "patched"
): void {
  if (inspectAsarState(stagedSourceAsar) !== expectedState) {
    throw new Error(`Staged ASAR validation failed: ${stagedSourceAsar}`);
  }

  const suffix = `.staging.${process.pid}`;
  const asarStaging = `${asarPath}${suffix}`;
  const asarPrev = `${asarPath}.prev.${process.pid}`;
  const shouldSyncUnpacked =
    Boolean(unpackedDir && stagedSourceUnpackedDir && fs.existsSync(stagedSourceUnpackedDir));
  const unpackedStaging = shouldSyncUnpacked ? `${unpackedDir}${suffix}` : "";
  const unpackedPrev = shouldSyncUnpacked ? `${unpackedDir}.prev.${process.pid}` : "";

  fs.rmSync(asarStaging, { force: true });
  fs.rmSync(asarPrev, { force: true });
  if (unpackedStaging) {
    fs.rmSync(unpackedStaging, { recursive: true, force: true });
    fs.rmSync(unpackedPrev, { recursive: true, force: true });
  }

  let movedAsarPrev = false;
  let movedUnpackedPrev = false;

  try {
    fs.copyFileSync(stagedSourceAsar, asarStaging);
    if (inspectAsarState(asarStaging) !== expectedState) {
      throw new Error("Copied staging ASAR failed verification.");
    }

    if (shouldSyncUnpacked && stagedSourceUnpackedDir) {
      copyDirSync(stagedSourceUnpackedDir, unpackedStaging);
    }

    if (fs.existsSync(asarPath)) {
      fs.renameSync(asarPath, asarPrev);
      movedAsarPrev = true;
    }

    if (shouldSyncUnpacked && unpackedDir && fs.existsSync(unpackedDir)) {
      fs.renameSync(unpackedDir, unpackedPrev);
      movedUnpackedPrev = true;
    }

    fs.renameSync(asarStaging, asarPath);
    if (shouldSyncUnpacked && unpackedDir) {
      fs.renameSync(unpackedStaging, unpackedDir);
    }

    if (movedAsarPrev) {
      fs.rmSync(asarPrev, { force: true });
    }
    if (movedUnpackedPrev) {
      fs.rmSync(unpackedPrev, { recursive: true, force: true });
    }
  } catch (error) {
    try {
      if (movedAsarPrev && fs.existsSync(asarPrev)) {
        fs.rmSync(asarPath, { force: true });
        fs.renameSync(asarPrev, asarPath);
      }
    } catch {
    }

    try {
      if (movedUnpackedPrev && unpackedDir && fs.existsSync(unpackedPrev)) {
        fs.rmSync(unpackedDir, { recursive: true, force: true });
        fs.renameSync(unpackedPrev, unpackedDir);
      }
    } catch {
    }

    fs.rmSync(asarStaging, { force: true });
    if (unpackedStaging) {
      fs.rmSync(unpackedStaging, { recursive: true, force: true });
    }
    throw error;
  }
}


export function patchStaticHtmlModules(
  extractDir: string,
  nativeDict: Record<string, string>
): void {
  for (const relPath of STATIC_HTML_TARGETS) {
    const filePath = path.join(extractDir, relPath);
    if (!fs.existsSync(filePath)) {
      continue;
    }

    let content = fs.readFileSync(filePath, "utf8");
    for (const [en, zh] of Object.entries(nativeDict)) {
      if (!zh || en.includes("{0}")) {
        continue;
      }

      content = content.replaceAll(`>${en}<`, `>${zh}<`);
      content = content.replaceAll(`>${en}\n`, `>${zh}\n`);
    }

    if (relPath === "dist/provisionSplash.js" && nativeDict["Setting up WSL: {0}"]) {
      content = content.replace(
        "Setting up WSL: ${escapeHtml(distro)}",
        nativeDict["Setting up WSL: {0}"].replace("{0}", "${escapeHtml(distro)}")
      );
    }

    fs.writeFileSync(filePath, content, "utf8");
  }
}


export function injectEntryFiles(extractDir: string, builtPreloadHookPath: string): void {
  const mainJsPath = path.join(extractDir, "dist", "main.js");
  const mainJs = fs.readFileSync(mainJsPath, "utf8");
  if (!mainJs.includes(PATCH_MARKER) && !mainJs.includes(LEGACY_PATCH_MARKER)) {
    const hookStmt = `${PATCH_MARKER} require("./i18n/main-hook");\n`;
    const nextMain = mainJs.startsWith("\"use strict\";")
      ? mainJs.replace("\"use strict\";", `"use strict";\n${hookStmt}`)
      : `${hookStmt}${mainJs}`;
    fs.writeFileSync(mainJsPath, nextMain, "utf8");
  }

  const preloadJsPath = path.join(extractDir, "dist", "preload.js");
  const preloadJs = fs.readFileSync(preloadJsPath, "utf8");
  if (!preloadJs.includes(PATCH_MARKER) && !preloadJs.includes(LEGACY_PATCH_MARKER)) {
    const hookCode = fs.readFileSync(builtPreloadHookPath, "utf8");
    const wrapped = `\n${PATCH_MARKER}\n(() => {\n${hookCode}\n})();\n`;
    fs.writeFileSync(preloadJsPath, `${preloadJs}${wrapped}`, "utf8");
  }
}
