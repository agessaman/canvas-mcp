/**
 * Read an image's pixel dimensions straight out of its header.
 *
 * This exists because hot-spot coordinates are fractions of the image, and the
 * one thing needed to convert a pixel position into a fraction is the image's
 * true size. Getting that wrong is the failure this type invites: the item is
 * well-formed, reads back perfectly, renders in the editor, and points at the
 * wrong part of the picture — visible only to whoever sits the quiz.
 *
 * Deliberately no image library. The only candidate that handles PNG and JPEG
 * in pure JS weighs 31MB against a 3.4MB bundle, to answer a question that the
 * first few dozen bytes of each format already contain.
 */
export interface ImageSize {
  width: number;
  height: number;
  format: 'png' | 'jpeg' | 'gif';
}

export function readImageSize(buffer: Buffer): ImageSize | undefined {
  return readPng(buffer) ?? readGif(buffer) ?? readJpeg(buffer);
}

// PNG: 8-byte signature, then an IHDR chunk whose first two 32-bit big-endian
// fields are width and height. Always at the same offset.
function readPng(b: Buffer): ImageSize | undefined {
  if (b.length < 24) return undefined;
  if (b.readUInt32BE(0) !== 0x89504e47 || b.readUInt32BE(4) !== 0x0d0a1a0a) return undefined;
  if (b.toString('ascii', 12, 16) !== 'IHDR') return undefined;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), format: 'png' };
}

// GIF: "GIF87a"/"GIF89a" then width and height as 16-bit LITTLE-endian.
function readGif(b: Buffer): ImageSize | undefined {
  if (b.length < 10) return undefined;
  const magic = b.toString('ascii', 0, 6);
  if (magic !== 'GIF87a' && magic !== 'GIF89a') return undefined;
  return { width: b.readUInt16LE(6), height: b.readUInt16LE(8), format: 'gif' };
}

// JPEG has no fixed header position: it is a chain of segments, and the size
// lives in whichever SOF marker the encoder used. Walk the chain rather than
// guessing an offset.
function readJpeg(b: Buffer): ImageSize | undefined {
  if (b.length < 4 || b.readUInt16BE(0) !== 0xffd8) return undefined;

  let offset = 2;
  while (offset + 9 < b.length) {
    if (b[offset] !== 0xff) {
      // Not on a marker boundary; the file is padded or malformed.
      offset++;
      continue;
    }
    const marker = b[offset + 1];

    // Standalone markers carry no length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    // Start of scan: pixel data follows, so any SOF is already behind us.
    if (marker === 0xda) return undefined;

    const length = b.readUInt16BE(offset + 2);
    if (length < 2) return undefined;

    // SOF0-SOF15 carry the dimensions, excluding the four markers in that
    // range that mean something else (DHT, JPG, DAC, and the restart markers
    // handled above).
    const isSof =
      marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      // Segment body: precision (1 byte), height (2), width (2).
      return {
        height: b.readUInt16BE(offset + 5),
        width: b.readUInt16BE(offset + 7),
        format: 'jpeg',
      };
    }
    offset += 2 + length;
  }
  return undefined;
}
