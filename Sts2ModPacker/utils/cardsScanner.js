import * as FileSystem from 'expo-file-system/legacy';
import { rootDir } from './fs';

export async function scanCardsData() {
  const tresRoot = rootDir + 'root/tres/';
  let cards = [];

  async function readDir(dir, parentCats, hasBetaAncestor) {
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists) return;

    const items = await FileSystem.readDirectoryAsync(dir);
    for (const item of items) {
      const fullPath = dir + item;
      const stat = await FileSystem.getInfoAsync(fullPath);

      if (stat.isDirectory) {
        const isBeta = item.toLowerCase() === 'beta';
        // Build category path: accumulate non-beta dirs, handle root specially
        const newParentCats = isBeta ? parentCats : [...parentCats, item];
        await readDir(fullPath + '/', newParentCats, hasBetaAncestor || isBeta);
      } else if (item.toLowerCase().endsWith('.tres')) {
        try {
          const content = await FileSystem.readAsStringAsync(fullPath);
          const atlasMatch = content.match(/path="res:\/\/[^"]+\/([^\/]+\.png)"/);
          const regionMatch = content.match(/region\s*=\s*Rect2\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
          const uidMatch = content.match(/uid="([^"]+)"/);

          if (atlasMatch && regionMatch) {
            const name = item.replace(/\.tres$/i, '');
            // Category: join parent dirs with " / " (excluding "beta")
            const cat = parentCats.length > 0 ? parentCats.join(' / ') : '未分类';
            cards.push({
              id: name,
              cat: cat,
              name: name,
              atlas: atlasMatch[1],
              x: parseInt(regionMatch[1], 10),
              y: parseInt(regionMatch[2], 10),
              w: parseInt(regionMatch[3], 10),
              h: parseInt(regionMatch[4], 10),
              is_beta: hasBetaAncestor,
              uid: uidMatch ? uidMatch[1] : ''
            });
          }
        } catch (e) {
          console.warn(`Failed to parse ${fullPath}:`, e);
        }
      }
    }
  }

  await readDir(tresRoot, [], false);
  return cards;
}
