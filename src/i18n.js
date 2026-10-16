import english from './locales/en.json';
const phrases = Object.entries(english).sort((a, b) => b[0].length - a[0].length);
let language = 'ja';
export const getLanguage = () => language;
export function translate(text, lang = language) {
  if (lang !== 'en' || typeof text !== 'string') return text;
  if (english[text] !== undefined) return english[text];
  let value = text;
  // Match longest phrases first; captured names, paths and numbers stay unchanged.
  for (const [ja, en] of phrases) value = value.split(ja).join(en);
  return value;
}
export function initLanguage() {
  try { language = localStorage.getItem('ms50g-language') === 'en' ? 'en' : 'ja'; } catch {}
  const originals = new WeakMap(), attributes = new WeakMap();
  const observer = new MutationObserver(refresh);
  function refresh() {
    observer.disconnect();
    document.documentElement.lang = language;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      // User-authored content is never translated.
      if (node.parentElement.closest('script,style,textarea,#backupSelect,.memory-entry strong')) continue;
      const previous = originals.get(node), source = previous?.rendered === node.data ? previous.source : node.data;
      const rendered = translate(source); originals.set(node, { source, rendered });
      if (node.data !== rendered) node.data = rendered;
    }
    for (const el of document.querySelectorAll('[placeholder],[aria-label],[title]')) {
      const records = attributes.get(el) || {};
      for (const key of ['placeholder', 'aria-label', 'title']) {
        const value = el.getAttribute(key); if (value === null) continue;
        const source = records[key]?.rendered === value ? records[key].source : value, rendered = translate(source);
        records[key] = { source, rendered }; if (value !== rendered) el.setAttribute(key, rendered);
      }
      attributes.set(el, records);
    }
    document.getElementById('language').value = language;
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['placeholder', 'aria-label', 'title'] });
  }
  document.getElementById('language').onchange = event => {
    language = event.target.value === 'en' ? 'en' : 'ja';
    try { localStorage.setItem('ms50g-language', language); } catch {}
    window.desktop?.setLanguage?.(language); refresh();
  };
  window.desktop?.setLanguage?.(language); refresh();
}
