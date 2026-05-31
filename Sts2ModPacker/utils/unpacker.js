import * as FileSystem from 'expo-file-system/legacy';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { decodeBase64, encodeBase64 } from './base64';

export async function unpackPck(pckPath, outDir) {
  try {
    const base64 = await FileSystem.readAsStringAsync(pckPath, { encoding: 'base64' });
    const pckData = decodeBase64(base64);
    const view = new DataView(pckData.buffer);

    // 1. Parse Header
    const magic = String.fromCharCode(...pckData.slice(0, 4));
    if (magic !== 'GDPC') throw new Error('Not a valid Godot PCK file');

    const flags = view.getUint32(20, true);
    const fileBase = view.getBigUint64(24, true);
    
    let indexOffset = 0n;
    if (flags & 2) {
      indexOffset = view.getBigUint64(32, true);
    }

    const startOffset = indexOffset ? Number(indexOffset) : 112;
    const fileCount = view.getUint32(startOffset, true);
    
    let currentPos = startOffset + 4;
    const files = [];

    for (let i = 0; i < fileCount; i++) {
      const pathLen = view.getUint32(currentPos, true);
      currentPos += 4;
      const pathBytes = pckData.slice(currentPos, currentPos + pathLen);
      // Simple manual utf8 decode for res:// paths
      const path = Array.from(pathBytes).map(b => String.fromCharCode(b)).join('').replace(/\0/g, '');
      currentPos += pathLen;
      
      const offset = view.getBigUint64(currentPos, true);
      currentPos += 8;
      const size = view.getBigUint64(currentPos, true);
      currentPos += 8;
      currentPos += 16; // md5
      currentPos += 4; // flags
      
      files.push({ path, offset: Number(fileBase + offset), size: Number(size) });
    }

    // 2. Extract Files
    await FileSystem.makeDirectoryAsync(outDir, { intermediates: true });
    
    for (const file of files) {
      const relPath = file.path.replace('res://', '');
      const targetPath = outDir + (outDir.endsWith('/') ? '' : '/') + relPath;
      
      const targetDir = targetPath.substring(0, targetPath.lastIndexOf('/'));
      await FileSystem.makeDirectoryAsync(targetDir, { intermediates: true });
      
      const fileContent = pckData.slice(file.offset, file.offset + file.size);
      const fileBase64 = encodeBase64(fileContent);
      await FileSystem.writeAsStringAsync(targetPath, fileBase64, { encoding: 'base64' });
    }

    // 3. Post-process Images (.ctex to .png)
    await restoreImages(outDir, outDir);

    return files.length;
  } catch (e) {
    console.error('Unpack error:', e);
    throw e;
  }
}

async function restoreImages(dir, rootDir) {
  const contents = await FileSystem.readDirectoryAsync(dir);
  for (const item of contents) {
    const fullPath = dir + (dir.endsWith('/') ? '' : '/') + item;
    const info = await FileSystem.getInfoAsync(fullPath);
    
    if (info.isDirectory) {
      await restoreImages(fullPath, rootDir);
    } else if (item.endsWith('.import')) {
      try {
        const importText = await FileSystem.readAsStringAsync(fullPath);
        // Match both path="res://..." and dest_files=["res://..."]
        const ctexMatch = importText.match(/"(res:\/\/\.godot\/imported\/.*?\.ctex)"/);
        
        if (ctexMatch) {
          const ctexResPath = ctexMatch[1];
          const ctexRelPath = ctexResPath.replace('res://', '');
          const ctexFullPath = rootDir + (rootDir.endsWith('/') ? '' : '/') + ctexRelPath;
          
          const ctexInfo = await FileSystem.getInfoAsync(ctexFullPath);
          if (ctexInfo.exists) {
            const ctexBase64 = await FileSystem.readAsStringAsync(ctexFullPath, { encoding: 'base64' });
            const ctexData = decodeBase64(ctexBase64);
            
            // Search for WebP start
            // Standard Godot 4 Lossless WebP has header GST2... size...
            // WebP data starts at offset 56 or where RIFF starts
            let webpStart = -1;
            for (let i = 0; i < 100 && i < ctexData.length - 4; i++) {
                if (ctexData[i] === 0x52 && ctexData[i+1] === 0x49 && ctexData[i+2] === 0x46 && ctexData[i+3] === 0x46) {
                    webpStart = i;
                    break;
                }
            }
            if (webpStart === -1) webpStart = 56;
            
            const webpData = ctexData.slice(webpStart);
            const webpBase64 = encodeBase64(webpData);
            
            // Save as temporary .webp
            const tempWebp = FileSystem.cacheDirectory + 'temp_unpack.webp';
            await FileSystem.writeAsStringAsync(tempWebp, webpBase64, { encoding: 'base64' });
            
            // Convert to PNG using expo-image-manipulator
            const manipResult = await manipulateAsync(tempWebp, [], { format: SaveFormat.PNG });
            
            // Target path is the .import path minus the .import suffix
            const targetPngPath = fullPath.substring(0, fullPath.lastIndexOf('.import'));
            await FileSystem.copyAsync({ from: manipResult.uri, to: targetPngPath });
            
            // Cleanup ctex and .import
            await FileSystem.deleteAsync(ctexFullPath, { idempotent: true });
            await FileSystem.deleteAsync(fullPath, { idempotent: true });
          }
        }
      } catch (err) {
        console.warn('Failed to restore image for', item, err);
      }
    }
  }
}
