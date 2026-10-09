export function normalizeKey(key: string): string {
  // U+200B aparece nas bordas da chave reenviada no log e não é removido por trim().
  return key.replace(/^[\s\u200B]+|[\s\u200B]+$/g, "").toLowerCase();
}
