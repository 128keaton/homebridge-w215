/*
 * Minimal, forgiving XML helpers.
 *
 * The plug's firmware returns XML that is not always well-formed (for example
 * GetModuleSOAPActions emits `<Acton>Name</Action>`), so a strict parser cannot be used.
 * Tag names passed to these helpers are always internal constants, never user input.
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

const UNESCAPES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character]);
}

export function unescapeXml(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => UNESCAPES[entity]);
}

/**
 * Returns the text of the first `<tag>` element, an empty string for an empty element,
 * or undefined when the element does not exist.
 */
export function readTag(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml);

  if (match) {
    return unescapeXml(match[1].trim());
  }

  return new RegExp(`<${tag}(?:\\s[^>]*)?/>`).test(xml) ? '' : undefined;
}

/** Returns the inner content of every `<tag>` element. */
export function readBlocks(xml: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  return Array.from(xml.matchAll(pattern), (match) => match[1]);
}
