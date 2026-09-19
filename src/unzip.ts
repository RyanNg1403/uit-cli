import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";

export interface ZipEntry {
  name: string;
  data: Buffer;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

export function readZipEntry(buffer: Buffer, requestedName: string, maxExpandedBytes: number): Buffer | undefined {
  if (!requestedName || !Number.isSafeInteger(maxExpandedBytes) || maxExpandedBytes <= 0) {
    throw new Error("invalid zip entry request");
  }
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0 || eocd + 22 > buffer.length) throw new Error("not a valid zip archive");

  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff ||
      centralOffset + centralSize > eocd) {
    throw new Error("unsupported zip archive");
  }

  let offset = centralOffset;
  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > eocd || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new Error("invalid zip central directory");
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const expandedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    if (nextOffset > eocd) throw new Error("invalid zip central directory");
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    offset = nextOffset;
    if (name !== requestedName) continue;

    if ((flags & 1) !== 0) throw new Error(`encrypted zip entry ${name} is not supported`);
    if (method !== 0 && method !== 8) throw new Error(`unsupported zip compression method ${method} for ${name}`);
    if (expandedSize > maxExpandedBytes) throw new Error(`zip entry ${name} exceeds the extraction limit`);
    if (localOffset + 30 > centralOffset || buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new Error(`invalid zip entry location for ${name}`);
    }
    if (buffer.readUInt16LE(localOffset + 8) !== method || (buffer.readUInt16LE(localOffset + 6) & 1) !== 0) {
      throw new Error(`mismatched zip entry ${name}`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > centralOffset) throw new Error(`invalid zip entry size for ${name}`);
    const localName = buffer.toString("utf8", localOffset + 30, localOffset + 30 + localNameLength);
    if (localName !== name) throw new Error(`mismatched zip entry name for ${name}`);

    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: maxExpandedBytes });
    if (data.length !== expandedSize) throw new Error(`invalid expanded size for zip entry ${name}`);
    return data;
  }
  if (offset !== centralOffset + centralSize) throw new Error("invalid zip central directory size");
  return undefined;
}

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
