import * as FileSystem from 'expo-file-system/legacy';

// The root of our internal file system
export const rootDir = FileSystem.documentDirectory;

export async function listFiles(path) {
  try {
    const files = await FileSystem.readDirectoryAsync(path);
    // Get info for each file
    const filesWithInfo = await Promise.all(
      files.map(async (f) => {
        const fullPath = path + (path.endsWith('/') ? '' : '/') + f;
        const info = await FileSystem.getInfoAsync(fullPath);
        return {
          name: f,
          path: fullPath,
          isDirectory: info.isDirectory,
          size: info.size,
          modificationTime: info.modificationTime
        };
      })
    );
    // Sort directories first, then alphabetically
    return filesWithInfo.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });
  } catch (e) {
    console.error("Error listing files:", e);
    return [];
  }
}

export async function ensureDir(path) {
  const info = await FileSystem.getInfoAsync(path);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(path, { intermediates: true });
  }
}

export async function moveFile(from, to) {
  await FileSystem.moveAsync({ from, to });
}

export async function copyFile(from, to) {
  await FileSystem.copyAsync({ from, to });
}

export async function deleteFile(path) {
  await FileSystem.deleteAsync(path, { idempotent: true });
}
