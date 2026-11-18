export type UiLocale = string;

export interface LocaleOption {
  id: string;
  label: string;
}

export interface CompiledPattern {
  rawKey: string;
  regex: RegExp;
  slots: number[];
  template: string;
  weight: number;
}

export interface PatchConfig {
  externalDictDir: string;
}

export interface ClientBundlePayload {
  bundleSeq: number;
  locale: UiLocale;
  availableLocales: LocaleOption[];
  exact: Record<string, string>;
  patterns: Record<string, string>;
  iconsIgnore: string[];
}
