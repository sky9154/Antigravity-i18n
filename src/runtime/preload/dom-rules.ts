const SKIP_TEXT_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEXTAREA",
  "INPUT",
  "SELECT",
  "OPTION",
  "CODE",
  "PRE",
  "SVG",
  "MATH",
  "KBD",
  "SAMP"
]);

const SKIP_ATTR_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "CODE",
  "PRE",
  "SVG",
  "MATH",
  "KBD",
  "SAMP"
]);

const SELF_MANAGED_SELECTOR = [
  "#agy-i18n-language-section",
  "#agy-i18n-language-menu",
  "[data-i18n-skip=\"1\"]"
].join(", ");

const PROTECTED_CONTAINERS = [
  ".monaco-editor",
  ".xterm",
  ".cm-editor",
  ".CodeMirror",
  ".vscode-chat-code-block",
  ".vscode-chat-code-compare-block",
  ".vscode-chat-editor",
  ".vscode-terminal",
  "[data-lexical-editor]",
  "[data-lexical-editor=\"true\"]",
  "[contenteditable=\"true\"]",
  "[contenteditable=\"plaintext-only\"]",
  "[contenteditable=\"\"]",
  "pre",
  "code",
  "kbd",
  "samp",
  ...SELF_MANAGED_SELECTOR.split(", ")
];

const ICON_SELECTORS = [
  ".material-symbols-outlined",
  ".material-symbols-rounded",
  ".material-symbols-sharp",
  ".material-icons",
  ".codicon"
];

const PROTECTED_TEXT_SELECTOR = [
  ...PROTECTED_CONTAINERS,
  "textarea",
  "input",
  "select",
  "option",
  ...ICON_SELECTORS
].join(", ");

const PROTECTED_ATTR_SELECTOR = [
  ...PROTECTED_CONTAINERS,
  ...ICON_SELECTORS
].join(", ");

export const UI_ATTRS = ["title", "placeholder", "aria-label", "alt"] as const;


export function isAllowedLocation(): boolean {
  const { hostname, protocol } = window.location;
  if (protocol === "data:" || protocol === "file:" || protocol === "plugin:") {
    return true;
  }
  return hostname === "127.0.0.1" || hostname === "localhost";
}


export function isEditableElement(el: Element | null): boolean {
  if (!el) {
    return false;
  }

  const ceAttr = el.getAttribute("contenteditable");
  if (ceAttr !== null && ceAttr !== "false") {
    return true;
  }

  if ("isContentEditable" in el && (el as HTMLElement).isContentEditable) {
    return true;
  }

  return false;
}


export function isSelfManagedNode(node: Node | null): boolean {
  if (!node) {
    return false;
  }

  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  if (!el) {
    return false;
  }

  return Boolean(el.closest(SELF_MANAGED_SELECTOR));
}


export function isProtectedSubtreeRoot(el: Element): boolean {
  if (SKIP_TEXT_TAGS.has(el.tagName)) {
    return true;
  }

  if (isEditableElement(el)) {
    return true;
  }

  return el.matches(PROTECTED_TEXT_SELECTOR) || Boolean(el.closest(PROTECTED_TEXT_SELECTOR));
}


export function isSkippedTextElement(el: Element | null): boolean {
  if (!el) {
    return true;
  }

  if (SKIP_TEXT_TAGS.has(el.tagName) || isEditableElement(el)) {
    return true;
  }

  return Boolean(el.closest(PROTECTED_TEXT_SELECTOR));
}


export function isSkippedAttrElement(el: Element | null): boolean {
  if (!el) {
    return true;
  }

  if (SKIP_ATTR_TAGS.has(el.tagName) || isEditableElement(el)) {
    return true;
  }

  return Boolean(el.closest(PROTECTED_ATTR_SELECTOR));
}
