import { extractText, getDocumentProxy } from 'unpdf';

/** Extract text from a generated PDF (what an ATS would read). */
export async function extractUntrusted(pdf: Buffer): Promise<string> {
  const doc = await getDocumentProxy(new Uint8Array(pdf));
  const { text } = await extractText(doc, { mergePages: true });
  return text;
}
