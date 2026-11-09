import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import reference from '../fixtures/nyc-night-photo.json';

test('the approved NYC display asset has the reviewed identity, small delivery size and no metadata chunks', () => {
  const bytes = readFileSync(new URL('../../src/assets/ramble-night.webp', import.meta.url));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(reference.sha256);
  expect(bytes.length).toBe(reference.bytes); expect(bytes.length).toBeLessThan(200_000);
  expect(bytes.toString('ascii', 0, 4)).toBe('RIFF'); expect(bytes.toString('ascii', 8, 12)).toBe('WEBP');
  expect(bytes.readUInt32LE(4) + 8).toBe(bytes.length);
  const chunks: string[] = [];
  let offset = 12;
  while (offset < bytes.length) {
    expect(offset + 8).toBeLessThanOrEqual(bytes.length);
    chunks.push(bytes.toString('ascii', offset, offset + 4));
    const size = bytes.readUInt32LE(offset + 4); offset += 8 + size + size % 2;
    expect(offset).toBeLessThanOrEqual(bytes.length);
  }
  expect(offset).toBe(bytes.length);
  // Inspect real RIFF chunk boundaries, not accidental strings inside compressed pixels.
  for (const metadata of ['EXIF', 'XMP ', 'ICCP']) expect(chunks).not.toContain(metadata);
  expect(chunks).toContain('VP8 ');
});
