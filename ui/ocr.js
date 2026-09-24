// Text from an image (Windows OCR, offline) onto the clipboard; used by the screenshot, clipboard
// and shelf menus.
import { call, toast } from './core.js';

export async function copyTextFrom(path) {
  toast('Reading text…');
  const text = await call('ocr_image', { path });
  if (text === undefined) return; // (call() already showed the error)
  if (!text.trim()) return toast('No text found in that image', true);
  if ((await call('copy_text', { text })) !== undefined) toast(`Copied ${text.trim().split(/\s+/).length} words`);
}
