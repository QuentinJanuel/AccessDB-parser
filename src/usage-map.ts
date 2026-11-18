import type { Version } from "./types";

function uint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function readPage(dbData: Uint8Array, pageSize: number, page: number): Uint8Array {
  if (!Number.isInteger(page) || page <= 0 || (page + 1) * pageSize > dbData.length) {
    throw new Error(`Usage map references missing page ${page}`);
  }
  return dbData.subarray(page * pageSize, (page + 1) * pageSize);
}

function readMapRecord(
  dbData: Uint8Array,
  pageSize: number,
  version: Version,
  pointer: number,
): Uint8Array {
  if (!Number.isInteger(pointer) || pointer <= 0 || pointer > 0xffffffff) {
    throw new Error(`Missing or invalid usage map pointer ${pointer}`);
  }
  const pageNumber = pointer >>> 8;
  const row = pointer & 0xff;
  const page = readPage(dbData, pageSize, pageNumber);
  if (page[0] !== 0x01) {
    throw new Error(`Usage map row ${row} is not on a data page (${pageNumber})`);
  }
  const view = new DataView(page.buffer, page.byteOffset, page.byteLength);
  const countOffset = version === 3 ? 8 : 12;
  const count = view.getUint16(countOffset, true);
  const directoryEnd = countOffset + 2 + count * 2;
  if (directoryEnd > pageSize || row >= count) {
    throw new Error(`Usage map row ${row} is outside page ${pageNumber}'s row directory`);
  }
  const rawStart = view.getUint16(countOffset + 2 + row * 2, true);
  if ((rawStart & 0xe000) !== 0) {
    throw new Error(`Usage map row ${row} on page ${pageNumber} has unsupported row flags`);
  }
  const start = rawStart;
  const end = row === 0 ? pageSize : view.getUint16(countOffset + row * 2, true) & 0x1fff;
  if (start < directoryEnd || start >= end || end > pageSize) {
    throw new Error(`Usage map row ${row} has invalid bounds on page ${pageNumber}`);
  }
  return page.subarray(start, end);
}

function appendBitmapPages(bitmap: Uint8Array, firstPage: number, pages: number[]): void {
  for (let byte = 0; byte < bitmap.length; byte += 1) {
    if (bitmap[byte] === 0) continue;
    for (let bit = 0; bit < 8; bit += 1) {
      if ((bitmap[byte] & (1 << bit)) !== 0) pages.push(firstPage + byte * 8 + bit);
    }
  }
}

/** Table-owned pages come from the usage map, never from an owner-header scan.
 * Format: https://github.com/mdbtools/mdbtools/blob/dev/HACKING.md#page-usage-maps
 */
export function readActiveTablePages(
  dbData: Uint8Array,
  pageSize: number,
  version: Version,
  tablePage: number,
  usageMapPointer: number,
): Uint8Array[] {
  const map = readMapRecord(dbData, pageSize, version, usageMapPointer);
  const pages: number[] = [];
  if (map[0] === 0x00) {
    if (map.length < 6) throw new Error("Truncated inline usage map");
    appendBitmapPages(map.subarray(5), uint32(map, 1), pages);
  } else if (map[0] === 0x01) {
    if (map.length < 5 || (map.length - 1) % 4 !== 0) {
      throw new Error("Truncated indirect usage map");
    }
    const bitsPerPage = (pageSize - 4) * 8;
    for (let offset = 1; offset < map.length; offset += 4) {
      const pageNumber = uint32(map, offset);
      if (pageNumber === 0) continue;
      const page = readPage(dbData, pageSize, pageNumber);
      if (page[0] !== 0x05) {
        throw new Error(`Usage map bitmap page ${pageNumber} has invalid type ${page[0]}`);
      }
      appendBitmapPages(page.subarray(4), ((offset - 1) / 4) * bitsPerPage, pages);
    }
  } else {
    throw new Error(`Unsupported usage map type ${map[0]}`);
  }
  return pages.map((pageNumber) => {
    const page = readPage(dbData, pageSize, pageNumber);
    if (page[0] !== 0x01) {
      throw new Error(`Active table page ${pageNumber} has invalid type ${page[0]}`);
    }
    const owner = uint32(page, 4);
    if (owner !== tablePage) {
      throw new Error(`Active page ${pageNumber} belongs to table ${owner}, expected ${tablePage}`);
    }
    return page;
  });
}
