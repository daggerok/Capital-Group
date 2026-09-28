/// <reference types="bun" />
// Test-only ZIP fixture rewriting; never imported by the updater.
import { unzipIssuerWorkbook } from './update-data';
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
export function offlineHoldings(ticker: string, input: Uint8Array): Buffer {
  const workbook = unzipIssuerWorkbook(input);
  const parts: Buffer[] = [], directory: Buffer[] = []; let offset = 0;
  for (const [name, xml] of workbook) {
    const path = Buffer.from(name), data = Buffer.from(xml.replaceAll('CGUS', ticker)), crc = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(path.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(path.length, 28); central.writeUInt32LE(offset, 42);
    parts.push(local, path, data); directory.push(central, path); offset += local.length + path.length + data.length;
  }
  const end = Buffer.alloc(22), dir = Buffer.concat(directory); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(workbook.size, 8); end.writeUInt16LE(workbook.size, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}
