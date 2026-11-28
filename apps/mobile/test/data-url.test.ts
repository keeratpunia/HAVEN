import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { dataUrlToBlob } from '../lib/data-url';

/** DEC-032: photo uploads must not fetch() a data: URL (the live CSP blocks it). */
describe('dataUrlToBlob', () => {
  it('decodes a base64 JPEG data URL into a Blob of the same bytes and type', async () => {
    const bytes = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10];
    const url = `data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`;
    const blob = dataUrlToBlob(url);
    expect(blob.type).toBe('image/jpeg');
    expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual(bytes);
  });

  it('refuses anything that is not a base64 data URL', () => {
    expect(() => dataUrlToBlob('https://example.com/x.jpg')).toThrow();
    expect(() => dataUrlToBlob('data:text/plain,hello')).toThrow();
  });

  it('is what every screen uses: no source file fetches a data URL any more', () => {
    const root = path.resolve(__dirname, '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (['node_modules', 'dist', 'e2e', 'test', '.expo'].includes(name)) continue;
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (
          /\.(ts|tsx)$/.test(name) &&
          /fetch\(\s*dataUrl\s*\)/.test(readFileSync(full, 'utf-8'))
        )
          offenders.push(path.relative(root, full));
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
