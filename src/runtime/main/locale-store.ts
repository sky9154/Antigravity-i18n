import electron from "electron";
import * as fs from "fs";
import * as path from "path";

import { compilePatterns, normalizeExactMap, translateWithDict } from "../../shared/pattern";
import type { ExactLookup } from "../../shared/pattern";
import type {
  ClientBundlePayload,
  CompiledPattern,
  LocaleOption,
  PatchConfig,
  UiLocale
} from "../../shared/types";


export interface LoadedDictionaries {
  locale: UiLocale;
  nativeMap: ExactLookup;
  nativePatterns: CompiledPattern[];
  exactMap: ExactLookup;
  patterns: CompiledPattern[];
  exactRaw: Record<string, string>;
  patternsRaw: Record<string, string>;
  iconsIgnore: string[];
}

interface StoredPrefs {
  locale?: UiLocale;
}

const DEFAULT_FALLBACK_LOCALE: LocaleOption = { id: "zh-TW", label: "zh-TW" };

let currentLocale: UiLocale = "zh-TW";
let prefsLoaded = false;
let cachedDicts: LoadedDictionaries | null = null;
let bundleSeqCounter = 0;


export function readJsonSafe<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch (error) {
    console.error(`[agy-i18n] Failed to read JSON (${filePath}):`, error);
    return fallback;
  }
}


function sanitizeStringDict(raw: unknown, filePath: string): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    console.error(`[agy-i18n] Invalid dictionary object in ${filePath}`);
    return {};
  }

  const sanitized: Record<string, string> = {};
  let invalidCount = 0;

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") {
      sanitized[key] = value;
    } else {
      invalidCount += 1;
    }
  }

  if (invalidCount > 0) {
    console.warn(`[agy-i18n] Ignored ${invalidCount} non-string entries in ${filePath}`);
  }

  return sanitized;
}


function sanitizeStringArray(raw: unknown, filePath: string): string[] {
  if (!Array.isArray(raw)) {
    console.error(`[agy-i18n] Invalid string array in ${filePath}`);
    return [];
  }

  const items = raw.filter((item): item is string => typeof item === "string");
  if (items.length !== raw.length) {
    console.warn(
      `[agy-i18n] Ignored ${raw.length - items.length} non-string items in ${filePath}`
    );
  }

  return items;
}


export function resolveBaseDictDir(): string {
  const envDir = process.env.ANTIGRAVITY_I18N_DICT_DIR ?? process.env.ANTIGRAVITY_ZHTW_DICT_DIR;
  if (envDir && fs.existsSync(envDir)) {
    return envDir;
  }

  const configPath = path.join(__dirname, "config.json");
  const config = readJsonSafe<PatchConfig>(configPath, { externalDictDir: "" });
  if (config.externalDictDir && fs.existsSync(config.externalDictDir)) {
    return config.externalDictDir;
  }

  return path.join(__dirname, "dict");
}


function resolveDictDirForLocale(locale: UiLocale): string | null {
  if (locale === "en") {
    return null;
  }

  const baseDir = resolveBaseDictDir();
  const subDir = path.join(baseDir, locale);
  if (fs.existsSync(path.join(subDir, "webui-exact.json"))) {
    return subDir;
  }

  if (locale === "zh-TW" && fs.existsSync(path.join(baseDir, "webui-exact.json"))) {
    return baseDir;
  }

  return null;
}


function readConfiguredLocales(baseDir: string): Record<string, string> {
  const localesPath = path.join(baseDir, "locales.json");
  if (!fs.existsSync(localesPath)) {
    return {};
  }

  return sanitizeStringDict(readJsonSafe<unknown>(localesPath, {}), localesPath);
}


function readLocaleDirLabel(dirPath: string, fallback: string): string {
  const metaPath = path.join(dirPath, "locale.json");
  if (!fs.existsSync(metaPath)) {
    return fallback;
  }

  const raw = readJsonSafe<unknown>(metaPath, null);
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const label = (raw as Record<string, unknown>).label;
    if (typeof label === "string" && label.trim()) {
      return label.trim();
    }
  }

  return fallback;
}


export function getAvailableLocales(): LocaleOption[] {
  const baseDir = resolveBaseDictDir();
  const configured = readConfiguredLocales(baseDir);
  const result: LocaleOption[] = [{ id: "en", label: "English" }];
  const seen = new Set<string>(["en"]);

  for (const [id, label] of Object.entries(configured)) {
    const trimmedLabel = label.trim();
    if (!id || !trimmedLabel || seen.has(id)) {
      continue;
    }

    const dir = resolveDictDirForLocale(id);
    if (dir) {
      result.push({ id, label: readLocaleDirLabel(dir, trimmedLabel) });
      seen.add(id);
    }
  }

  try {
    if (fs.existsSync(baseDir)) {
      for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue;
        }
        const id = entry.name;
        if (seen.has(id)) {
          continue;
        }
        const subDir = path.join(baseDir, id);
        if (fs.existsSync(path.join(subDir, "webui-exact.json"))) {
          result.push({ id, label: readLocaleDirLabel(subDir, id) });
          seen.add(id);
        }
      }
    }
  } catch (error) {
    console.warn(`[agy-i18n] Failed to scan locale directories in ${baseDir}:`, error);
  }

  if (!seen.has("zh-TW") && fs.existsSync(path.join(baseDir, "webui-exact.json"))) {
    result.push({
      id: "zh-TW",
      label: configured["zh-TW"]?.trim() || DEFAULT_FALLBACK_LOCALE.label
    });
    seen.add("zh-TW");
  }

  if (result.length === 1) {
    result.push(DEFAULT_FALLBACK_LOCALE);
  }

  return result;
}


export function normalizeLocale(candidate: unknown): UiLocale {
  if (typeof candidate !== "string") {
    return "zh-TW";
  }

  const available = getAvailableLocales();
  return available.some((item) => item.id === candidate) ? candidate : "zh-TW";
}


function resolvePrefsPath(filename = "agy-i18n-prefs.json"): string {
  try {
    return path.join(electron.app.getPath("userData"), filename);
  } catch {
    return path.join(resolveBaseDictDir(), filename);
  }
}


export function ensurePrefsLoaded(): UiLocale {
  if (prefsLoaded) {
    return currentLocale;
  }

  prefsLoaded = true;
  const primaryPath = resolvePrefsPath("agy-i18n-prefs.json");
  const targetPath = fs.existsSync(primaryPath)
    ? primaryPath
    : resolvePrefsPath("agy-zhtw-prefs.json");
  const prefs = readJsonSafe<StoredPrefs>(targetPath, {});
  if (prefs.locale) {
    currentLocale = normalizeLocale(prefs.locale);
  }
  return currentLocale;
}


export function reloadPrefsAfterReady(): boolean {
  const prev = currentLocale;
  prefsLoaded = false;
  const loaded = ensurePrefsLoaded();
  if (loaded !== prev) {
    loadDictionaries(true, loaded);
    return true;
  }
  return false;
}


export function persistLocale(locale: UiLocale): void {
  currentLocale = normalizeLocale(locale);
  prefsLoaded = true;
  try {
    const filePath = resolvePrefsPath("agy-i18n-prefs.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ locale: currentLocale }, null, 2), "utf8");
  } catch (error) {
    console.error("[agy-i18n] Failed to persist locale preference:", error);
  }
}


export function loadDictionaries(
  forceReload = false,
  locale = ensurePrefsLoaded()
): LoadedDictionaries {
  if (cachedDicts && !forceReload && cachedDicts.locale === locale) {
    return cachedDicts;
  }

  const dir = resolveDictDirForLocale(locale);
  if (!dir) {
    const emptyLookup = normalizeExactMap({});
    cachedDicts = {
      locale,
      nativeMap: emptyLookup,
      nativePatterns: [],
      exactMap: emptyLookup,
      patterns: [],
      exactRaw: {},
      patternsRaw: {},
      iconsIgnore: []
    };
    return cachedDicts;
  }

  const nativePath = path.join(dir, "native.json");
  const exactPath = path.join(dir, "webui-exact.json");
  const patternsPath = path.join(dir, "webui-patterns.json");
  const iconsPath = path.join(dir, "icons-ignore.json");

  const nativeRaw = sanitizeStringDict(readJsonSafe<unknown>(nativePath, {}), nativePath);
  const exactRaw = sanitizeStringDict(readJsonSafe<unknown>(exactPath, {}), exactPath);
  const patternsRaw = sanitizeStringDict(readJsonSafe<unknown>(patternsPath, {}), patternsPath);
  const iconsIgnore = sanitizeStringArray(readJsonSafe<unknown>(iconsPath, []), iconsPath);

  cachedDicts = {
    locale,
    nativeMap: normalizeExactMap(nativeRaw),
    nativePatterns: compilePatterns(nativeRaw),
    exactMap: normalizeExactMap(exactRaw),
    patterns: compilePatterns(patternsRaw),
    exactRaw,
    patternsRaw,
    iconsIgnore
  };

  return cachedDicts;
}


export function buildClientBundle(forceReload = false): ClientBundlePayload {
  const locale = ensurePrefsLoaded();
  const dicts = loadDictionaries(forceReload, locale);
  bundleSeqCounter += 1;
  return {
    bundleSeq: bundleSeqCounter,
    locale,
    availableLocales: getAvailableLocales(),
    exact: dicts.exactRaw,
    patterns: dicts.patternsRaw,
    iconsIgnore: dicts.iconsIgnore
  };
}


export function translateNativeText(text: string): string {
  const locale = ensurePrefsLoaded();
  if (!text || locale === "en") {
    return text;
  }

  const dicts = loadDictionaries(false, locale);
  const trimmed = text.trim();
  const nativeHit =
    dicts.nativeMap.exact.get(trimmed) ?? dicts.nativeMap.lower.get(trimmed.toLowerCase());
  if (nativeHit) {
    return nativeHit;
  }

  const nativePatternHit = translateWithDict(text, dicts.nativeMap, dicts.nativePatterns);
  if (nativePatternHit) {
    return nativePatternHit;
  }

  const webHit = translateWithDict(text, dicts.exactMap, dicts.patterns);
  return webHit ?? text;
}
