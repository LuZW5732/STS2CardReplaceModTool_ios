import SparkMD5 from 'spark-md5';
import { encodeBase64 } from './utils/base64';

export function createPckBuffer(filesInfo) {
    const fileBase = 112n; // Use BigInt for Q (Uint64)
    let currentOffset = 0n;
    
    let fileEntries = [];
    
    // filesInfo is [{ godot_path: "res://...", data: Uint8Array }]
    for (const info of filesInfo) {
        const size = BigInt(info.data.byteLength);
        const md5Hex = SparkMD5.ArrayBuffer.hash(info.data);
        const md5Bytes = new Uint8Array(16);
        for(let i=0; i<16; i++) md5Bytes[i] = parseInt(md5Hex.substr(i*2, 2), 16);

        // Strip res:// prefix — Godot PCK expects bare paths
        let pckPath = info.godot_path;
        if (pckPath.startsWith('res://')) pckPath = pckPath.substring(6);

        fileEntries.push({
            path: pckPath,
            offset: currentOffset,
            size: size,
            md5: md5Bytes,
            data: info.data
        });
        currentOffset += size;
    }

    const indexOffset = fileBase + currentOffset;

    // Calculate total buffer size needed for index
    let indexSize = 4; // file_count
    for (const entry of fileEntries) {
        // path bytes WITHOUT null terminator (matching Godot editor format)
        const pathBytes = new Uint8Array(entry.path.length);
        for (let i = 0; i < entry.path.length; i++) {
            pathBytes[i] = entry.path.charCodeAt(i);
        }
        entry.pathBytes = pathBytes;
        indexSize += 4 + pathBytes.byteLength + 8 + 8 + 16 + 4;
    }
    
    const totalSize = Number(indexOffset) + indexSize;
    const buffer = new ArrayBuffer(totalSize);
    const view = new DataView(buffer);
    const u8 = new Uint8Array(buffer);
    
    let writeOffset = 0;
    // Magic GDPC
    u8.set([0x47, 0x44, 0x50, 0x43], writeOffset); writeOffset += 4;
    view.setUint32(writeOffset, 3, true); writeOffset += 4;
    view.setUint32(writeOffset, 4, true); writeOffset += 4;
    view.setUint32(writeOffset, 5, true); writeOffset += 4;
    view.setUint32(writeOffset, 1, true); writeOffset += 4;
    view.setUint32(writeOffset, 2, true); writeOffset += 4;
    view.setBigUint64(writeOffset, fileBase, true); writeOffset += 8;
    view.setBigUint64(writeOffset, indexOffset, true); writeOffset += 8;
    
    writeOffset = 112; // file_base
    
    for (const entry of fileEntries) {
        u8.set(entry.data, writeOffset);
        writeOffset += Number(entry.size);
    }
    
    // Should be at indexOffset now
    view.setUint32(writeOffset, fileEntries.length, true); writeOffset += 4;
    
    for (const entry of fileEntries) {
        view.setUint32(writeOffset, entry.pathBytes.byteLength, true); writeOffset += 4;
        u8.set(entry.pathBytes, writeOffset); writeOffset += entry.pathBytes.byteLength;
        view.setBigUint64(writeOffset, entry.offset, true); writeOffset += 8;
        view.setBigUint64(writeOffset, entry.size, true); writeOffset += 8;
        u8.set(entry.md5, writeOffset); writeOffset += 16;
        view.setUint32(writeOffset, 0, true); writeOffset += 4;
    }
    
    return u8;
}

export function createCtexBuffer(width, height, webpBytes) {
    const headerSize = 56;
    const buffer = new ArrayBuffer(headerSize + webpBytes.byteLength);
    const view = new DataView(buffer);
    const u8 = new Uint8Array(buffer);
    
    // b'GST2'
    u8.set([0x47, 0x53, 0x54, 0x32], 0);
    view.setUint32(4, 1, true);
    view.setUint32(8, width, true);
    view.setUint32(12, height, true);
    view.setUint32(16, 201326592, true);
    view.setInt32(20, -1, true); // -1
    view.setUint32(24, 0, true);
    view.setUint32(28, 0, true);
    view.setUint32(32, 0, true);
    view.setUint32(36, 2, true);
    const packed_wh = (height << 16) | width;
    view.setUint32(40, packed_wh, true);
    view.setUint32(44, 0, true);
    view.setUint32(48, 5, true);
    view.setUint32(52, webpBytes.byteLength, true);
    
    u8.set(webpBytes, 56);
    return u8;
}
