import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";

export interface ZipEntry {
  name: string;
  data: Buffer;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

// Read a ZIP archive from a buffer using its central directory, so entries with
// streamed sizes (data descriptors) are handled correctly. Only the stored (0)
// and deflate (8) compression methods are supported — the two H5P packages use.
export function parseZip(buffer: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw new Error("not a valid zip archive");

  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];

  for (let i = 0; i < entryCount; i++) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);

    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`unsupported zip compression method ${method} for ${name}`);

    entries.push({ name, data });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const earliest = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= earliest; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

// Unpack the content/ payload of a downloaded .h5p package (the lesson data plus
// any embedded media) into destDir, dropping the H5P library/runtime files.
export function extractH5pPackage(h5pPath: string, destDir: string): string[] {
  const prefix = "content/";
  const root = resolve(destDir);
  const written: string[] = [];

  for (const entry of parseZip(readFileSync(h5pPath))) {
    if (entry.name.endsWith("/")) continue;
    if (!entry.name.startsWith(prefix)) continue;
    // Normalize separators so backslash entries can't slip a ".." past the check on Windows.
    const relative = entry.name.slice(prefix.length).replace(/\\/g, "/");
    if (!relative || relative.split("/").some((segment) => segment === "..")) continue;

    const target = resolve(root, relative);
    if (target !== root && !target.startsWith(root + sep)) continue;

    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.data);
    written.push(target);
  }

  return written;
}
