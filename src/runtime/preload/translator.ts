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

interface LeafSegments {
  segments: Text[][];
  allTextNodes: Text[];
  codeCount: number;
}

const INLINE_CODE_TAGS = new Set(["CODE", "KBD"]);


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

    writeTranslatedTextNode(node, sourceText, next);
  }

  function writeTranslatedTextNode(node: Text, original: string, translated: string): void {
    textState.set(node, {
      locale: activeLocale,
      bundleVersion,
      original,
      translated
    });
    if (node.nodeValue !== translated) {
      node.nodeValue = translated;
    }
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

  function getOriginalNodeText(node: Text): string {
    const current = node.nodeValue ?? "";
    const prev = textState.get(node);
    return prev && current === prev.translated ? prev.original : current;
  }

  function isTextLeafAlreadyApplied(textNodes: Text[]): boolean {
    if (textNodes.length === 0) {
      return false;
    }

    for (const node of textNodes) {
      const prev = textState.get(node);
      if (
        !prev ||
        prev.locale !== activeLocale ||
        prev.bundleVersion !== bundleVersion ||
        prev.translated !== (node.nodeValue ?? "")
      ) {
        return false;
      }
    }

    return true;
  }

  function collectLeafSegments(el: Element): LeafSegments | null {
    const children = Array.from(el.childNodes);
    if (children.length < 2 || children.length > 12) {
      return null;
    }

    const segments: Text[][] = [[]];
    const allTextNodes: Text[] = [];
    let codeCount = 0;
    let nonEmptyTextCount = 0;

    for (const child of children) {
      if (child.nodeType === Node.TEXT_NODE) {
        const textNode = child as Text;
        segments[segments.length - 1].push(textNode);
        allTextNodes.push(textNode);
        if (getOriginalNodeText(textNode).trim().length > 0) {
          nonEmptyTextCount += 1;
        }
        continue;
      }

      if (child.nodeType !== Node.ELEMENT_NODE) {
        return null;
      }

      const childEl = child as Element;
      if (!INLINE_CODE_TAGS.has(childEl.tagName) || childEl.children.length > 0) {
        return null;
      }

      const codeText = childEl.textContent ?? "";
      if (!codeText.trim() || codeText.length > 60) {
        return null;
      }

      codeCount += 1;
      segments.push([]);
    }

    if (allTextNodes.length === 0 || (nonEmptyTextCount < 2 && codeCount === 0)) {
      return null;
    }

    return { segments, allTextNodes, codeCount };
  }

  function applyPlainLeafTranslation(allTextNodes: Text[], combined: string): boolean {
    if (combined.length > 360 || !/[A-Za-z]/.test(combined) || iconsIgnore.has(combined.trim())) {
      return false;
    }

    const translated = translateWithDict(combined, exactMap, patterns);
    if (!translated || translated === combined) {
      return false;
    }

    let written = false;
    for (const node of allTextNodes) {
      const orig = getOriginalNodeText(node);
      const isTarget = !written && orig.trim().length > 0;
      const nextVal = isTarget ? translated : "";
      if (isTarget) {
        written = true;
      }
      writeTranslatedTextNode(node, orig, nextVal);
    }

    return written;
  }

  function applyCodeLeafTranslation(
    segments: Text[][],
    segmentOriginals: string[],
    codeCount: number
  ): boolean {
    let probeText = segmentOriginals[0] ?? "";
    const markers: string[] = [];
    for (let i = 0; i < codeCount; i += 1) {
      const marker = `\u001E${i}\u001F`;
      markers.push(marker);
      probeText += marker + (segmentOriginals[i + 1] ?? "");
    }

    if (probeText.length > 360 || !/[A-Za-z]/.test(probeText)) {
      return false;
    }

    const translated = translateWithDict(probeText, exactMap, patterns);
    if (!translated || translated === probeText) {
      return false;
    }

    const parts: string[] = [];
    let cursor = 0;
    for (const marker of markers) {
      const idx = translated.indexOf(marker, cursor);
      if (idx === -1) {
        return false;
      }
      parts.push(translated.slice(cursor, idx));
      cursor = idx + marker.length;
    }
    parts.push(translated.slice(cursor));

    for (let i = 0; i < parts.length; i += 1) {
      if (parts[i].length > 0 && segments[i].length === 0) {
        return false;
      }
    }

    for (let i = 0; i < segments.length; i += 1) {
      const nodes = segments[i];
      const partText = parts[i] ?? "";
      for (let j = 0; j < nodes.length; j += 1) {
        const node = nodes[j];
        writeTranslatedTextNode(node, getOriginalNodeText(node), j === 0 ? partText : "");
      }
    }

    return true;
  }

  function translateLeafElement(el: Element): boolean {
    if (activeLocale === "en" || isProtectedSubtreeRoot(el) || isSelfManagedNode(el)) {
      return false;
    }

    const parsed = collectLeafSegments(el);
    if (!parsed) {
      return false;
    }

    if (isTextLeafAlreadyApplied(parsed.allTextNodes)) {
      return true;
    }

    const segmentOriginals = parsed.segments.map((nodes) =>
      nodes.map((node) => getOriginalNodeText(node)).join("")
    );

    if (parsed.codeCount === 0) {
      return applyPlainLeafTranslation(parsed.allTextNodes, segmentOriginals[0] ?? "");
    }

    return applyCodeLeafTranslation(parsed.segments, segmentOriginals, parsed.codeCount);
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

      if (translateLeafElement(el)) {
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
          if (el !== root && translateLeafElement(el)) {
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

        if (mutation.type === "characterData") {
          const parent = mutation.target.parentElement;
          scheduleScan(parent && !isProtectedSubtreeRoot(parent) ? parent : mutation.target);
          continue;
        }

        if (mutation.type === "attributes") {
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

  function shouldCollectMissing(val: string, alreadyTranslated: boolean): boolean {
    return (
      !alreadyTranslated &&
      val.length >= 2 &&
      val.length <= 160 &&
      /[A-Za-z]{2,}/.test(val) &&
      !/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(val) &&
      !iconsIgnore.has(val) &&
      !exactMap.exact.has(val)
    );
  }

  function collectMissingStrings(): string[] {
    if (activeLocale === "en") {
      return [];
    }

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
        const prev = textState.get(textNode);
        const alreadyTranslated = Boolean(
          prev && prev.locale === activeLocale && prev.translated === (textNode.nodeValue ?? "")
        );

        if (
          shouldCollectMissing(val, alreadyTranslated) &&
          !isSkippedTextElement(parent) &&
          !/^https?:\/\//i.test(val)
        ) {
          collected.add(val);
        }
      } else if (current.nodeType === Node.ELEMENT_NODE) {
        const el = current as Element;
        if (!isSkippedAttrElement(el)) {
          const prevAttrs = attrState.get(el);
          for (const attr of UI_ATTRS) {
            const rawVal = el.getAttribute(attr) ?? "";
            const val = rawVal.trim();
            const prevAttr = prevAttrs?.get(attr);
            const alreadyTranslated = Boolean(
              prevAttr && prevAttr.locale === activeLocale && prevAttr.translated === rawVal
            );
            if (shouldCollectMissing(val, alreadyTranslated)) {
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
