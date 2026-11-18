import { compilePatterns, normalizeExactMap, translateWithDict } from "../../shared/pattern";
import type { ExactLookup } from "../../shared/pattern";
import type { ClientBundlePayload, CompiledPattern, LocaleOption, UiLocale } from "../../shared/types";
import {
  isProtectedSubtreeRoot,
  isSelfManagedNode,
  isSkippedAttrElement,
  isSkippedTextElement,
  UI_ATTRS
} from "./dom-rules";
import type { LocaleViewState } from "./language-dropdown";


interface TextTranslationRecord {
  locale: UiLocale;
  bundleVersion: number;
  original: string;
  translated: string;
}


export function createTranslatorEngine(
  initialBundle: ClientBundlePayload,
  onAfterScan?: () => void
) {
  let activeLocale: UiLocale = initialBundle.locale;
  let availableLocales: LocaleOption[] = initialBundle.availableLocales;
  let exactMap: ExactLookup = normalizeExactMap(initialBundle.exact);
  let patterns: CompiledPattern[] = compilePatterns(initialBundle.patterns);
  let iconsIgnore = new Set(initialBundle.iconsIgnore.map((s) => s.toLowerCase()));
  let bundleVersion = 1;

  const textState = new WeakMap<Text, TextTranslationRecord>();
  const attrState = new WeakMap<Element, Map<string, TextTranslationRecord>>();
  const observedRoots = new WeakSet<Node>();
  const trackedShadowRoots = new Set<WeakRef<ShadowRoot>>();
  const activeObservers = new Set<MutationObserver>();
  const pendingRoots = new Set<Node>();
  let flushScheduled = false;
  let destroyed = false;

  function translateTextNode(node: Text): void {
    const current = node.nodeValue;
    if (!current) {
      return;
    }

    const prev = textState.get(node);
    if (activeLocale === "en") {
      if (prev && current === prev.translated) {
        node.nodeValue = prev.original;
      }
      return;
    }

    if (
      prev &&
      prev.locale === activeLocale &&
      prev.bundleVersion === bundleVersion &&
      prev.translated === current
    ) {
      return;
    }

    const sourceText = prev && current === prev.translated ? prev.original : current;
    if (!/[A-Za-z]/.test(sourceText)) {
      return;
    }

    const parent = node.parentElement;
    if (isSkippedTextElement(parent)) {
      return;
    }

    const trimmed = sourceText.trim();
    if (iconsIgnore.has(trimmed)) {
      return;
    }

    const next = translateWithDict(sourceText, exactMap, patterns);
    if (!next || next === sourceText) {
      if (prev && current === prev.translated) {
        node.nodeValue = prev.original;
      }
      return;
    }

    textState.set(node, {
      locale: activeLocale,
      bundleVersion,
      original: sourceText,
      translated: next
    });
    node.nodeValue = next;
  }

  function translateElementAttributes(el: Element): void {
    if (isSkippedAttrElement(el)) {
      return;
    }

    let prevAttrs = attrState.get(el);

    for (const attr of UI_ATTRS) {
      const val = el.getAttribute(attr);
      if (!val) {
        continue;
      }

      const prevRecord = prevAttrs?.get(attr);
      if (activeLocale === "en") {
        if (prevRecord && val === prevRecord.translated) {
          el.setAttribute(attr, prevRecord.original);
        }
        continue;
      }

      if (
        prevRecord &&
        prevRecord.locale === activeLocale &&
        prevRecord.bundleVersion === bundleVersion &&
        prevRecord.translated === val
      ) {
        continue;
      }

      const sourceVal = prevRecord && val === prevRecord.translated ? prevRecord.original : val;
      if (!/[A-Za-z]/.test(sourceVal)) {
        continue;
      }

      if (iconsIgnore.has(sourceVal.trim())) {
        continue;
      }

      const next = translateWithDict(sourceVal, exactMap, patterns);
      if (!next || next === sourceVal) {
        if (prevRecord && val === prevRecord.translated) {
          el.setAttribute(attr, prevRecord.original);
        }
        continue;
      }

      if (!prevAttrs) {
        prevAttrs = new Map<string, TextTranslationRecord>();
        attrState.set(el, prevAttrs);
      }

      prevAttrs.set(attr, {
        locale: activeLocale,
        bundleVersion,
        original: sourceVal,
        translated: next
      });
      el.setAttribute(attr, next);
    }
  }

  function scanTree(root: Node): void {
    if (isSelfManagedNode(root)) {
      return;
    }

    if (root.nodeType === Node.TEXT_NODE) {
      translateTextNode(root as Text);
      return;
    }

    if (root.nodeType === Node.ELEMENT_NODE) {
      const el = root as Element;
      translateElementAttributes(el);
      if (isProtectedSubtreeRoot(el)) {
        return;
      }

      if (el.shadowRoot) {
        observeRoot(el.shadowRoot);
        scanTree(el.shadowRoot);
      }
    }

    const doc = root.ownerDocument ?? document;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node: Node): number {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node as Element;
          if (isProtectedSubtreeRoot(el)) {
            translateElementAttributes(el);
            return NodeFilter.FILTER_REJECT;
          }
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let current = walker.nextNode();

    while (current) {
      if (current.nodeType === Node.TEXT_NODE) {
        translateTextNode(current as Text);
      } else if (current.nodeType === Node.ELEMENT_NODE) {
        const el = current as Element;
        translateElementAttributes(el);
        if (el.shadowRoot) {
          observeRoot(el.shadowRoot);
          scanTree(el.shadowRoot);
        }
      }
      current = walker.nextNode();
    }
  }

  function flushPending(): void {
    flushScheduled = false;
    if (destroyed) {
      pendingRoots.clear();
      return;
    }

    const batch = Array.from(pendingRoots);
    pendingRoots.clear();

    for (const node of batch) {
      if ((node.isConnected || node instanceof ShadowRoot) && !isSelfManagedNode(node)) {
        scanTree(node);
      }
    }

    onAfterScan?.();
  }

  function scheduleScan(node: Node): void {
    if (destroyed || isSelfManagedNode(node)) {
      return;
    }

    pendingRoots.add(node);
    if (flushScheduled) {
      return;
    }

    flushScheduled = true;
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(flushPending);
    } else {
      setTimeout(flushPending, 16);
    }
  }

  function observeRoot(root: Node): void {
    if (destroyed || observedRoots.has(root)) {
      return;
    }
    observedRoots.add(root);

    if (root instanceof ShadowRoot) {
      trackedShadowRoots.add(new WeakRef(root));
    }

    const observer = new MutationObserver((mutations) => {
      if (destroyed) {
        return;
      }

      for (const mutation of mutations) {
        if (isSelfManagedNode(mutation.target)) {
          continue;
        }

        const targetEl =
          mutation.target.nodeType === Node.ELEMENT_NODE
            ? (mutation.target as Element)
            : mutation.target.parentElement;
        if (targetEl && isProtectedSubtreeRoot(targetEl)) {
          if (mutation.type === "attributes" && !isSkippedAttrElement(targetEl)) {
            scheduleScan(targetEl);
          }
          continue;
        }

        if (mutation.type === "characterData" || mutation.type === "attributes") {
          scheduleScan(mutation.target);
          continue;
        }

        for (const added of mutation.addedNodes) {
          if (!isSelfManagedNode(added)) {
            scheduleScan(added);
          }
        }
      }
    });

    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...UI_ATTRS]
    });
    activeObservers.add(observer);
  }

  function runFullPass(): void {
    if (document.documentElement) {
      observeRoot(document.documentElement);
    } else if (document.body) {
      observeRoot(document.body);
    }

    if (document.body) {
      scanTree(document.body);
    }

    if (document.head) {
      const titleEl = document.head.querySelector("title");
      if (titleEl) {
        scanTree(titleEl);
      }
    }

    for (const ref of Array.from(trackedShadowRoots)) {
      const shadow = ref.deref();
      if (!shadow || !shadow.isConnected) {
        trackedShadowRoots.delete(ref);
        continue;
      }
      scanTree(shadow);
    }

    onAfterScan?.();
  }

  function collectMissingStrings(): string[] {
    const collected = new Set<string>();
    const root = document.body;
    if (!root) {
      return [];
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let current = walker.nextNode();

    while (current) {
      if (current.nodeType === Node.TEXT_NODE) {
        const textNode = current as Text;
        const val = (textNode.nodeValue ?? "").trim();
        const parent = textNode.parentElement;

        if (
          val.length >= 2 &&
          val.length <= 160 &&
          /[A-Za-z]{2,}/.test(val) &&
          !/[\u4e00-\u9fff]/.test(val) &&
          !isSkippedTextElement(parent) &&
          !iconsIgnore.has(val) &&
          !exactMap.exact.has(val) &&
          !/^https?:\/\//i.test(val)
        ) {
          collected.add(val);
        }
      } else if (current.nodeType === Node.ELEMENT_NODE) {
        const el = current as Element;
        if (!isSkippedAttrElement(el)) {
          for (const attr of UI_ATTRS) {
            const val = (el.getAttribute(attr) ?? "").trim();
            if (
              val.length >= 2 &&
              val.length <= 160 &&
              /[A-Za-z]{2,}/.test(val) &&
              !/[\u4e00-\u9fff]/.test(val) &&
              !iconsIgnore.has(val) &&
              !exactMap.exact.has(val)
            ) {
              collected.add(val);
            }
          }
        }
      }
      current = walker.nextNode();
    }

    return Array.from(collected);
  }

  return {
    start(): void {
      runFullPass();
    },
    attachShadowRoot(shadow: ShadowRoot): void {
      observeRoot(shadow);
      scanTree(shadow);
    },
    applyBundle(nextBundle: ClientBundlePayload): void {
      activeLocale = nextBundle.locale;
      availableLocales = nextBundle.availableLocales;
      exactMap = normalizeExactMap(nextBundle.exact);
      patterns = compilePatterns(nextBundle.patterns);
      iconsIgnore = new Set(nextBundle.iconsIgnore.map((s) => s.toLowerCase()));
      bundleVersion += 1;
      runFullPass();
    },
    getLocaleState(): LocaleViewState {
      return {
        activeLocale,
        availableLocales
      };
    },
    collectMissingStrings,
    translateText(text: string): string {
      if (!text || activeLocale === "en") {
        return text;
      }
      return translateWithDict(text, exactMap, patterns) ?? text;
    },
    destroy(): void {
      destroyed = true;
      pendingRoots.clear();
      trackedShadowRoots.clear();
      for (const observer of activeObservers) {
        observer.disconnect();
      }
      activeObservers.clear();
    }
  };
}
