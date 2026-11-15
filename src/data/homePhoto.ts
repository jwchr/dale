// One explicitly chosen decorative photo. Never store the source file, filename or source metadata.
export const PHOTO_DB = 'dale-home-photo-v1';
const TABLE = 'photo', KEY = 'home';
export const MAX_PHOTO_INPUT = 12 * 1024 * 1024;
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
export interface HomePhoto { version: string; blob: Blob }
export type PhotoProblem = 'format' | 'large' | 'decode' | 'storage' | 'conflict';
export class PhotoError extends Error {
  constructor(public readonly problem: PhotoProblem) { super(problem); }
}

/** Decode raster files and encode fresh pixels: source GPS/EXIF/XMP and names never persist. */
export async function prepareHomePhoto(file: Blob): Promise<Blob> {
  if (!file.size || file.size > MAX_PHOTO_INPUT) throw new PhotoError('large');
  let b: Uint8Array;
  try { b = new Uint8Array(await file.slice(0, 16).arrayBuffer()); } catch { throw new PhotoError('decode'); }
  const jpeg = file.type === 'image/jpeg' && b[0] === 255 && b[1] === 216 && b[2] === 255;
  const png = file.type === 'image/png' && [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => b[i] === v);
  const webp = file.type === 'image/webp' && String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP';
  if (!jpeg && !png && !webp) throw new PhotoError('format');
  let image: ImageBitmap | undefined;
  const canvas = document.createElement('canvas');
  try {
    // All supported modern phone browsers supply createImageBitmap. Fail visibly if unavailable.
    image = await createImageBitmap(file, { imageOrientation: 'from-image' });
    if (!image.width || !image.height || image.width * image.height > 40_000_000) throw new PhotoError('large');
    const scale = Math.min(1, 2048 / Math.max(image.width, image.height));
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new PhotoError('decode');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', .82));
    if (!blob || blob.type !== 'image/jpeg' || !blob.size) throw new PhotoError('decode');
    if (blob.size > MAX_PHOTO_BYTES) throw new PhotoError('large');
    return blob;
  } catch (error) { throw error instanceof PhotoError ? error : new PhotoError('decode'); }
  finally { image?.close(); canvas.width = canvas.height = 0; }
}

function validPhoto(value: unknown): value is HomePhoto {
  if (!value || typeof value !== 'object') return false;
  const p = value as Partial<HomePhoto>;
  return Object.keys(p).length === 2 && typeof p.version === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(p.version) && p.blob instanceof Blob &&
    p.blob.type === 'image/jpeg' && p.blob.size > 0 && p.blob.size <= MAX_PHOTO_BYTES;
}

function openPhotoDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const fail = () => { finished = true; clearTimeout(timer); reject(new PhotoError('storage')); };
    const timer = setTimeout(fail, 5000);
    try {
      const request = indexedDB.open(PHOTO_DB, 1);
      request.onupgradeneeded = () => { request.result.createObjectStore(TABLE); };
      request.onerror = fail; request.onblocked = fail;
      request.onsuccess = () => {
        const db = request.result;
        if (finished) { db.close(); return; }
        finished = true; clearTimeout(timer); db.onversionchange = () => db.close(); resolve(db);
      };
    } catch { fail(); }
  });
}

/** Read and compare/write occur in one transaction, so a stale tab cannot erase a newer choice. */
export async function homePhotoRecord(change?: { expected: string | null; blob: Blob | null }): Promise<HomePhoto | null> {
  const db = await openPhotoDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(TABLE, change ? 'readwrite' : 'readonly');
      const table = tx.objectStore(TABLE);
      let result: HomePhoto | null = null, problem: PhotoProblem = 'storage';
      const request = table.get(KEY);
      request.onsuccess = () => {
        try {
          if (request.result !== undefined && !validPhoto(request.result)) { tx.abort(); return; }
          result = request.result ?? null;
          if (!change) return;
          if ((result?.version ?? null) !== change.expected) { problem = 'conflict'; tx.abort(); return; }
          if (change.blob) {
            result = { version: crypto.randomUUID(), blob: change.blob };
            if (!validPhoto(result)) { tx.abort(); return; }
            table.put(result, KEY);
          } else { table.delete(KEY); result = null; }
        } catch { tx.abort(); }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(new PhotoError(problem));
      tx.onerror = () => { /* The transaction abort handler reports failure, never request success. */ };
    });
  } finally { db.close(); }
}
