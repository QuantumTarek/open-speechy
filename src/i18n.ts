export function t(
  key: string,
  fallback: string,
  substitutions?: string | string[],
): string {
  try {
    return chrome.i18n.getMessage(key, substitutions) || fallback;
  } catch {
    return fallback;
  }
}

export function setDocumentLanguage(document: Document): void {
  let language = "en";
  try {
    language = chrome.i18n.getUILanguage().toLowerCase();
  } catch {
    // Keep English as the fallback in test pages.
  }
  document.documentElement.lang = language;
  document.documentElement.dir = language.startsWith("ar") ? "rtl" : "ltr";
}
