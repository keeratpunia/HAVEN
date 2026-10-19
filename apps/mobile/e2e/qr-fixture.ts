import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';

/**
 * Writes a Y4M video (what Chrome's `--use-file-for-fake-video-capture` plays as the
 * camera) showing one QR code, black on white, so the in-app scanner (FR-22) can be
 * tested end to end. Grey-scale 4:2:0: the Y plane is the picture, U and V are neutral.
 */
export function writeQrY4m(file: string, text: string, width = 640, height = 480): void {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size;
  const quiet = 4;
  const scale = Math.floor(Math.min(width, height) / (size + 2 * quiet));
  const qrPx = (size + 2 * quiet) * scale;
  const left = Math.floor((width - qrPx) / 2);
  const top = Math.floor((height - qrPx) / 2);

  const y = Buffer.alloc(width * height, 255);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!qr.modules.get(r, c)) continue;
      for (let dy = 0; dy < scale; dy++) {
        const row = top + (r + quiet) * scale + dy;
        y.fill(
          0,
          row * width + left + (c + quiet) * scale,
          row * width + left + (c + quiet + 1) * scale,
        );
      }
    }
  }
  const chroma = Buffer.alloc((width / 2) * (height / 2), 128);
  const frame = Buffer.concat([Buffer.from('FRAME\n'), y, chroma, chroma]);
  const header = Buffer.from(`YUV4MPEG2 W${width} H${height} F10:1 Ip A1:1 C420jpeg\n`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Buffer.concat([header, frame, frame]));
}
