import { inflateRawSync } from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

const EOCD_SIGNATURE_BYTES = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

export function unzipSync(archive) {
  const buffer = Buffer.isBuffer(archive) ? archive : Buffer.from(archive);

  const eocdOffset = buffer.lastIndexOf(EOCD_SIGNATURE_BYTES);
  if (eocdOffset < 0) {
    throw new Error("Not a ZIP archive (end of central directory not found).");
  }

  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  let cursor = buffer.readUInt32LE(eocdOffset + 16);
  const entries = new Map();

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_DIR_SIGNATURE) {
      throw new Error("Corrupted ZIP central directory.");
    }

    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const path = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength);

    if (!path.endsWith("/")) {
      if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
        throw new Error(`Unsupported ZIP compression method ${method}: ${path}`);
      }

      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const raw = buffer.subarray(dataStart, dataStart + compressedSize);

      entries.set(
        path,
        method === METHOD_STORED ? Buffer.from(raw) : inflateRawSync(raw)
      );
    }

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}
