import * as asar from "@electron/asar";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  copyDirSync,
  deployAsarAtomically,
  ensureBackup,
  injectEntryFiles,
  inspectAsarState,
  patchStaticHtmlModules,
  readAppVersion,
  verifyBackupForRestore,
  verifyUnpackedCompleteness
} from "./asar-ops";
import {
  ensureAntigravityStopped,
  isAntigravityRunning,
  relaunchAntigravity
} from "./process";
import type { PatchConfig } from "../shared/types";


const DEFAULT_APP_DIR = path.join(
  process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
  "Programs",
  "antigravity"
);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");


function resolveNativeDictPath(dictSrcDir: string, preferredLocale?: string): string | null {
  if (preferredLocale) {
    const candidate = path.join(dictSrcDir, preferredLocale, "native.json");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  const localesPath = path.join(dictSrcDir, "locales.json");
  if (fs.existsSync(localesPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(localesPath, "utf8")) as Record<string, unknown>;
      for (const localeId of Object.keys(manifest)) {
        if (localeId === "en") {
          continue;
        }
        const candidate = path.join(dictSrcDir, localeId, "native.json");
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    } catch {
    }
  }

  if (fs.existsSync(dictSrcDir)) {
    for (const entry of fs.readdirSync(dictSrcDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const candidate = path.join(dictSrcDir, entry.name, "native.json");
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  const legacyPath = path.join(dictSrcDir, "native.json");
  return fs.existsSync(legacyPath) ? legacyPath : null;
}


async function applyPatch(
  appDir: string,
  options: { kill: boolean; relaunch: boolean; locale?: string }
): Promise<void> {
  const resourcesDir = path.join(appDir, "resources");
  const asarPath = path.join(resourcesDir, "app.asar");
  const backupPath = path.join(resourcesDir, "app.asar.bak");
  const metaPath = path.join(resourcesDir, "app.asar.bak.meta.json");

  if (!fs.existsSync(asarPath)) {
    throw new Error(`app.asar not found: ${asarPath}`);
  }

  await ensureAntigravityStopped(appDir, options.kill, "patching");

  const builtMainHook = path.join(PROJECT_ROOT, "dist", "i18n", "main-hook.js");
  const builtPreloadHook = path.join(PROJECT_ROOT, "dist", "i18n", "preload-hook.js");
  if (!fs.existsSync(builtMainHook) || !fs.existsSync(builtPreloadHook)) {
    throw new Error("Built runtime hooks not found in dist/i18n/. Run `bun run build` first.");
  }

  const version = readAppVersion(appDir);
  ensureBackup(asarPath, backupPath, metaPath, version);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-i18n-"));
  const workAsar = path.join(tmpDir, "orig.asar");
  const workUnpacked = path.join(tmpDir, "orig.asar.unpacked");
  const srcUnpacked = path.join(resourcesDir, "app.asar.unpacked");
  const extractDir = path.join(tmpDir, "app");
  const outAsar = path.join(tmpDir, "app.asar");

  try {
    console.log("Extracting app.asar.bak...");
    fs.copyFileSync(backupPath, workAsar);
    if (fs.existsSync(srcUnpacked)) {
      copyDirSync(srcUnpacked, workUnpacked);
    }
    asar.extractAll(workAsar, extractDir);

    const targetI18nDir = path.join(extractDir, "dist", "i18n");
    fs.mkdirSync(targetI18nDir, { recursive: true });
    fs.copyFileSync(builtMainHook, path.join(targetI18nDir, "main-hook.js"));

    const dictSrcDir = path.join(PROJECT_ROOT, "dict");
    copyDirSync(dictSrcDir, path.join(targetI18nDir, "dict"));

    const config: PatchConfig = { externalDictDir: dictSrcDir };
    fs.writeFileSync(path.join(targetI18nDir, "config.json"), JSON.stringify(config, null, 2), "utf8");

    const nativeDictPath = resolveNativeDictPath(dictSrcDir, options.locale);
    const nativeDict = nativeDictPath
      ? (JSON.parse(fs.readFileSync(nativeDictPath, "utf8")) as Record<string, string>)
      : {};

    patchStaticHtmlModules(extractDir, nativeDict);
    injectEntryFiles(extractDir, builtPreloadHook);

    console.log("Repacking app.asar...");
    await asar.createPackageWithOptions(extractDir, outAsar, {
      unpackDir: "node_modules/chrome-devtools-mcp"
    });

    const outUnpacked = `${outAsar}.unpacked`;
    verifyUnpackedCompleteness(srcUnpacked, outUnpacked);

    deployAsarAtomically(asarPath, outAsar, srcUnpacked, outUnpacked, "patched");
    console.log(`Successfully patched ${asarPath} (v${version})`);
    if (options.relaunch) {
      relaunchAntigravity(appDir);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}


async function restorePatch(
  appDir: string,
  options: { kill: boolean; relaunch: boolean }
): Promise<void> {
  const resourcesDir = path.join(appDir, "resources");
  const asarPath = path.join(resourcesDir, "app.asar");
  const backupPath = path.join(resourcesDir, "app.asar.bak");
  const metaPath = path.join(resourcesDir, "app.asar.bak.meta.json");

  if (!fs.existsSync(backupPath)) {
    throw new Error(`Backup not found: ${backupPath}`);
  }

  verifyBackupForRestore(appDir, backupPath, metaPath);
  await ensureAntigravityStopped(appDir, options.kill, "restoring");

  deployAsarAtomically(asarPath, backupPath, undefined, undefined, "unpatched");
  console.log(`Restored original app.asar from ${backupPath}`);
  if (options.relaunch) {
    relaunchAntigravity(appDir);
  }
}


function printStatus(appDir: string): void {
  const resourcesDir = path.join(appDir, "resources");
  const asarPath = path.join(resourcesDir, "app.asar");
  const backupPath = path.join(resourcesDir, "app.asar.bak");

  const state = fs.existsSync(asarPath) ? inspectAsarState(asarPath) : "corrupt";
  let runningStatus: string;
  try {
    runningStatus = isAntigravityRunning(appDir) ? "yes" : "no";
  } catch (error) {
    runningStatus = `unknown (${error instanceof Error ? error.message : String(error)})`;
  }

  console.log(`App dir: ${appDir}`);
  console.log(`App version: ${readAppVersion(appDir)}`);
  console.log(`Running: ${runningStatus}`);
  console.log(`app.asar exists: ${fs.existsSync(asarPath) ? "yes" : "no"}`);
  console.log(`Patched: ${state}`);
  console.log(`Backup exists: ${fs.existsSync(backupPath) ? "yes" : "no"}`);
}


function parseArgs(argv: string[]): {
  command: string;
  appDir: string;
  kill: boolean;
  relaunch: boolean;
  locale?: string;
} {
  let command = "status";
  let appDir = DEFAULT_APP_DIR;
  let kill = false;
  let relaunch = false;
  let locale: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--app-dir" && argv[i + 1]) {
      appDir = argv[i + 1];
      i += 1;
    } else if (arg === "--locale" && argv[i + 1]) {
      locale = argv[i + 1];
      i += 1;
    } else if (arg === "--kill" || arg === "-k") {
      kill = true;
    } else if (arg === "--relaunch" || arg === "-r") {
      relaunch = true;
    } else if (arg === "apply" || arg === "restore" || arg === "status" || arg === "kill") {
      command = arg;
    }
  }

  return { command, appDir, kill, relaunch, locale };
}


async function main(): Promise<void> {
  const { command, appDir, kill, relaunch, locale } = parseArgs(process.argv.slice(2));

  if (command === "kill") {
    await ensureAntigravityStopped(appDir, true, "closing");
    console.log("Antigravity.exe is stopped.");
    return;
  }

  if (command === "apply") {
    await applyPatch(appDir, { kill, relaunch, locale });
    return;
  }

  if (command === "restore") {
    await restorePatch(appDir, { kill, relaunch });
    return;
  }

  printStatus(appDir);
}


main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Error: ${msg}`);
  process.exit(1);
});
