import React, { useState, useRef, useEffect } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, Image, Alert, ActivityIndicator, TextInput, Modal, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system/legacy';
import JSZip from 'jszip';
import * as ImageManipulator from 'expo-image-manipulator';
import SparkMD5 from 'spark-md5';
import { useBindings } from '../utils/BindingContext';
import { createPckBuffer, createCtexBuffer } from '../packer';
import { decodeBase64, encodeBase64 } from '../utils/base64';
import PackerEngine from '../components/PackerEngine';
import CropperModal from '../components/CropperModal';

// --- Helpers ---

function norm(s) {
  return (s || '').replace(/[\s_\-.]/g, '').toLowerCase();
}

function extractKey(filename) {
  let s = filename.replace(/\.[^/.]+$/, '');
  for (const prefix of ['MegaCrit.Sts2.Core.Models.Cards.', 'MegaCrit.', 'STS2.']) {
    if (s.startsWith(prefix)) { s = s.substring(prefix.length); break; }
  }
  for (const suffix of ['_portrait', '_Portrait', '_card_art', '_Card_Art', '_card', '_Card', '_art', '_Art', '_full', '_Full', '_img', '_Img', '_image', '_Image']) {
    if (s.toLowerCase().endsWith(suffix.toLowerCase())) { s = s.substring(0, s.length - suffix.length); }
  }
  return s;
}

function resolveTresRelPath(card) {
  const cat = card.cat.replace(/ \/ /g, '/');
  if (cat === '未分类') return null;
  return `${cat}/${card.name}.tres`;
}

function resolveNormalCard(card, allCards) {
  if (!card.is_beta) return card;
  const normal = allCards.find(c =>
    c.cat === card.cat && c.name === card.name && !c.is_beta
  );
  return normal || card;
}

function generateUid(seed) {
  const hash = SparkMD5.hash(seed);
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(hash.substr(i * 2, 2), 16);
  const b64 = encodeBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return 'uid://' + b64;
}

function generateImportText(atlasName, uid) {
  const sp = `res://ArtWorks/Atlas/${atlasName}`;
  const hash = SparkMD5.hash(sp);
  return `[remap]\nimporter="texture"\ntype="CompressedTexture2D"\nuid="${uid}"\npath="res://.godot/imported/${atlasName}-${hash}.ctex"\nmetadata={\n"vram_texture": false\n}\n`;
}

function generateTresRemap(hashHex, cardName) {
  return `[remap]\n\npath="res://ArtWorks/Atlas/mod/${hashHex}-${cardName}.tres"\n`;
}

function generateTresFile(atlasSp, uid, x, y, w, h) {
  return `[gd_resource type="AtlasTexture" load_steps=2 format=3 uid="${uid}"]
[ext_resource type="Texture2D" path="${atlasSp}" id="1"]
[resource]
atlas = ExtResource("1")
region = Rect2(${x}, ${y}, ${w}, ${h})
`;
}

function buildUidCacheBin(cards) {
  const entries = cards.map(c => {
    const tresSp = `res://images/atlases/card_atlas.sprites/${c.relpath}`;
    let uidStr = c.card.uid || '';
    let uid8;
    if (uidStr.startsWith('uid://')) {
      uidStr = uidStr.substring(6);
      let val = 0n;
      for (const ch of uidStr) {
        let v;
        if (ch >= '0' && ch <= '9') v = ch.charCodeAt(0) - 48;
        else if (ch >= 'a' && ch <= 'z') v = ch.charCodeAt(0) - 97 + 10;
        else if (ch >= 'A' && ch <= 'Z') v = ch.charCodeAt(0) - 65 + 36;
        else v = 0;
        val = (val * 62n + BigInt(v)) & 0xFFFFFFFFFFFFFFFFn;
      }
      uid8 = new Uint8Array(8);
      new DataView(uid8.buffer).setBigUint64(0, val, true);
    } else {
      const md5Hex = SparkMD5.hash(tresSp);
      uid8 = new Uint8Array(8);
      for (let i = 0; i < 8; i++) uid8[i] = parseInt(md5Hex.substr(i * 2, 2), 16);
    }
    const pathBytes = new Uint8Array(tresSp.length);
    for (let i = 0; i < tresSp.length; i++) pathBytes[i] = tresSp.charCodeAt(i);
    const lenBytes = new Uint8Array(4);
    new DataView(lenBytes.buffer).setUint32(0, tresSp.length, true);
    return { uid8, lenBytes, pathBytes };
  });

  const countBytes = new Uint8Array(4);
  new DataView(countBytes.buffer).setUint32(0, entries.length, true);
  let totalLen = 4;
  for (const e of entries) totalLen += 8 + 4 + e.pathBytes.length;
  const result = new Uint8Array(totalLen);
  let offset = 0;
  result.set(countBytes, offset); offset += 4;
  for (const e of entries) {
    result.set(e.uid8, offset); offset += 8;
    result.set(e.lenBytes, offset); offset += 4;
    result.set(e.pathBytes, offset); offset += e.pathBytes.length;
  }
  return result;
}

// Transform from CropperModal UI space to original-image crop rectangle
function calculateCrop(imageWidth, imageHeight, cardW, cardH, transform) {
  const { x, y, scale } = transform || { x: 0, y: 0, scale: 1 };
  // Image fitted size in 1000x1000 viewer
  const renderW = imageWidth > imageHeight ? 1000 : 1000 * (imageWidth / imageHeight);
  const renderH = imageHeight > imageWidth ? 1000 : 1000 * (imageHeight / imageWidth);
  const maskW = cardW / 2;
  const maskH = cardH / 2;
  // Visible area size in fitted coords
  const visW = maskW / scale;
  const visH = maskH / scale;
  // Visible area center in fitted coords (pan inverted)
  const visCX = -x + renderW / 2;
  const visCY = -y + renderH / 2;
  // Convert to original image coords
  const sx = renderW / imageWidth;
  const sy = renderH / imageHeight;
  return {
    originX: Math.round((visCX - visW / 2) / sx),
    originY: Math.round((visCY - visH / 2) / sy),
    width: Math.round(visW / sx),
    height: Math.round(visH / sy)
  };
}

// --- Mod Info Modal ---
function ModInfoModal({ visible, onClose, onConfirm, initial }) {
  const [pckName, setPckName] = useState(initial?.pckName || 'CardReplaceMod1');
  const [modName, setModName] = useState(initial?.modName || 'STS2 iOS Mod');
  const [author, setAuthor] = useState(initial?.author || '');
  const [desc, setDesc] = useState(initial?.desc || '');
  const [version, setVersion] = useState(initial?.version || '1.0.0');

  return (
    <Modal visible={visible} animationType="slide" transparent>
      <View style={styles.modalOverlay}>
        <View style={styles.modalContent}>
          <Text style={styles.modalTitle}>Mod 信息</Text>
          {[
            ['PCK 名称', pckName, setPckName],
            ['Mod 名称', modName, setModName],
            ['作者', author, setAuthor],
            ['描述', desc, setDesc],
            ['版本', version, setVersion],
          ].map(([label, value, setter], i) => (
            <View key={i} style={styles.fieldRow}>
              <Text style={styles.fieldLabel}>{label}:</Text>
              <TextInput style={styles.fieldInput} value={value} onChangeText={setter} placeholderTextColor="#8A7E81" />
            </View>
          ))}
          <View style={styles.modalBtns}>
            <TouchableOpacity onPress={onClose} style={styles.modalBtnCancel}>
              <Text style={styles.modalBtnCancelText}>取消</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => onConfirm({ pckName, modName, author, desc, version })} style={styles.modalBtnOk}>
              <Text style={styles.modalBtnOkText}>确定</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// --- History Modal ---
function HistoryModal({ visible, onClose, onRestore, onDelete, records }) {
  const renderItem = ({ item }) => (
    <View style={styles.historyItem}>
      <View style={styles.historyInfo}>
        <Text style={styles.historyTime}>{item.time}</Text>
        <Text style={styles.historyMeta}>{item.bindCount} 张绑定 | {item.pckName || 'CardReplaceMod1'}</Text>
      </View>
      <View style={styles.historyActions}>
        <TouchableOpacity onPress={() => onRestore(item)} style={styles.historyBtn}>
          <Ionicons name="refresh" size={22} color="#A3D9A5" />
        </TouchableOpacity>
        <TouchableOpacity onPress={() => onDelete(item.id)} style={styles.historyBtn}>
          <Ionicons name="trash-outline" size={22} color="#E88A96" />
        </TouchableOpacity>
      </View>
    </View>
  );

  return (
    <Modal visible={visible} animationType="slide" transparent>
      <View style={styles.modalOverlay}>
        <View style={[styles.modalContent, { maxHeight: '80%' }]}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <Text style={styles.modalTitle}>导出历史</Text>
            <TouchableOpacity onPress={onClose}><Ionicons name="close" size={24} color="#8A7E81" /></TouchableOpacity>
          </View>
          {records.length === 0 ? (
            <Text style={{ color: '#8A7E81', textAlign: 'center', padding: 30 }}>暂无导出记录</Text>
          ) : (
            <FlatList
              data={records}
              keyExtractor={item => item.id}
              renderItem={renderItem}
              style={{ maxHeight: 400 }}
            />
          )}
        </View>
      </View>
    </Modal>
  );
}

// --- Helpers for history persistence ---
const HISTORY_DIR = FileSystem.documentDirectory + 'history/';

async function ensureHistoryDir() {
  const info = await FileSystem.getInfoAsync(HISTORY_DIR);
  if (!info.exists) await FileSystem.makeDirectoryAsync(HISTORY_DIR, { intermediates: true });
}

async function loadHistory() {
  await ensureHistoryDir();
  try {
    const items = await FileSystem.readDirectoryAsync(HISTORY_DIR);
    const records = [];
    for (const item of items) {
      if (item.endsWith('.json')) {
        const content = await FileSystem.readAsStringAsync(HISTORY_DIR + item);
        records.push(JSON.parse(content));
      }
    }
    records.sort((a, b) => b.timestamp - a.timestamp);
    return records;
  } catch (e) { return []; }
}

async function saveHistory(pckName, modInfo, stagingImages, cardsData) {
  await ensureHistoryDir();
  const now = new Date();
  const id = `export_${now.toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
  const record = {
    id,
    time: now.toLocaleString('zh-CN'),
    timestamp: now.getTime(),
    pckName,
    modInfo,
    bindCount: stagingImages.filter(img => img.binding).length,
    // Save serializable binding state
    bindings: stagingImages.map(img => ({
      name: img.name,
      uri: img.uri,
      binding: img.binding ? { ...img.binding } : null
    }))
  };
  // Copy images to history folder so they persist across sessions
  for (const img of stagingImages) {
    const destName = `${id}_${img.name}`;
    try {
      const destInfo = await FileSystem.getInfoAsync(HISTORY_DIR + destName);
      if (!destInfo.exists) {
        await FileSystem.copyAsync({ from: img.uri, to: HISTORY_DIR + destName });
      }
      // Update binding uri reference
      const bindingRec = record.bindings.find(b => b.name === img.name);
      if (bindingRec) bindingRec.historyUri = HISTORY_DIR + destName;
    } catch (e) { console.warn('Failed to copy image for history:', e); }
  }
  await FileSystem.writeAsStringAsync(HISTORY_DIR + id + '.json', JSON.stringify(record));
  return record;
}

async function deleteHistory(id) {
  const jsonPath = HISTORY_DIR + id + '.json';
  try {
    const content = await FileSystem.readAsStringAsync(jsonPath);
    const record = JSON.parse(content);
    // Delete associated images
    for (const b of (record.bindings || [])) {
      if (b.historyUri) await FileSystem.deleteAsync(b.historyUri, { idempotent: true });
    }
  } catch (e) {}
  await FileSystem.deleteAsync(jsonPath, { idempotent: true });
}

// --- Main Component ---

export default function BindingScreen() {
  const { stagingImages, setStagingImages, cardsData, removeImageFromStaging, updateBinding } = useBindings();
  const [selectedImage, setSelectedImage] = useState(null);
  const [isCropperVisible, setIsCropperVisible] = useState(false);
  const [isPacking, setIsPacking] = useState(false);
  const [packStep, setPackStep] = useState('');
  const [showModInfo, setShowModInfo] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [modInfo, setModInfo] = useState({ pckName: 'CardReplaceMod1', modName: 'STS2 iOS Mod', author: '', desc: '', version: '1.0.0' });
  const [historyRecords, setHistoryRecords] = useState([]);
  const [multiSelectMode, setMultiSelectMode] = useState(false);
  const [selectedUris, setSelectedUris] = useState(new Set());
  const packerEngineRef = useRef(null);
  const canvasCallbackRef = useRef(null);

  const autoBindAll = () => {
    if (stagingImages.length === 0) {
      Alert.alert('提示', '没有可绑定的图片，请先从文件浏览中添加！');
      return;
    }

    let successCount = 0;
    const failList = [];

    const newImages = stagingImages.map(img => {
      if (img.binding) return img; // skip already bound

      const key = extractKey(img.name);
      if (!key) {
        failList.push(img.name);
        return img;
      }

      const nKey = norm(key);
      let bestMatch = null;
      for (const c of cardsData) {
        const rn = norm(c.name);
        if (rn && rn.length > 0 && nKey.includes(rn)) {
          if (!bestMatch || rn.length > norm(bestMatch.name).length) {
            bestMatch = c;
          }
        }
      }

      // Only bind if exactly one unique match
      if (bestMatch) {
        // Check if there are multiple cards with the same normalized name (ambiguous)
        const sameNameCount = cardsData.filter(c => norm(c.name) === norm(bestMatch.name)).length;
        if (sameNameCount > 1) {
          failList.push(img.name);
          return img;
        }
        successCount++;
        return {
          ...img,
          binding: {
            cardId: bestMatch.id,
            cardName: bestMatch.name,
            cardCat: bestMatch.cat,
            isBeta: bestMatch.is_beta || false,
            atlas: bestMatch.atlas,
            rect: { x: bestMatch.x, y: bestMatch.y, w: bestMatch.w, h: bestMatch.h },
            transform: { x: 0, y: 0, scale: 1 }
          }
        };
      } else {
        failList.push(img.name);
        return img;
      }
    });

    setStagingImages(newImages);

    const total = successCount + failList.length;
    if (failList.length === 0) {
      Alert.alert('自动绑定完成', `全部 ${successCount} 张图片已成功绑定！`);
    } else {
      Alert.alert(
        '自动绑定结果',
        `成功绑定: ${successCount} 个\n未能绑定: ${failList.length} 个\n\n以下图片未能自动绑定：\n${failList.join('\n')}`,
        [{ text: '确定' }]
      );
    }
  };

  const selectAll = () => {
    setSelectedUris(new Set(stagingImages.map(img => img.uri)));
  };

  const invertSelection = () => {
    const newSel = new Set();
    stagingImages.forEach(img => {
      if (!selectedUris.has(img.uri)) newSel.add(img.uri);
    });
    setSelectedUris(newSel);
  };

  const deleteSelected = () => {
    if (selectedUris.size === 0) return;
    Alert.alert('确认', `确定要删除选中的 ${selectedUris.size} 个项目吗？`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除', style: 'destructive', onPress: () => {
          const remaining = stagingImages.filter(img => !selectedUris.has(img.uri));
          setStagingImages(remaining);
          setSelectedUris(new Set());
          setMultiSelectMode(false);
        }
      }
    ]);
  };

  const toggleSelectUri = (uri) => {
    const newSel = new Set(selectedUris);
    if (newSel.has(uri)) newSel.delete(uri);
    else newSel.add(uri);
    setSelectedUris(newSel);
  };

  const handleOpenCropper = (image) => {
    setSelectedImage(image);
    setIsCropperVisible(true);
  };

  const handleStartPack = async () => {
    const boundOnes = stagingImages.filter(img => img.binding);
    if (boundOnes.length === 0) { Alert.alert("提示", "请至少绑定一张卡牌后再导出"); return; }

    setShowModInfo(true);
  };

  const doPack = async (finalModInfo) => {
    setShowModInfo(false);
    const boundOnes = stagingImages.filter(img => img.binding);
    if (boundOnes.length === 0) return;

    setIsPacking(true);
    setModInfo(finalModInfo);
    try {
      setPackStep('正在裁剪图片...');

      // 1. Crop+resize each image to card dimensions using native manipulator
      const atlasCards = [];
      for (const img of boundOnes) {
        const binding = img.binding;
        const originalCard = cardsData.find(c => c.id === binding.cardId && c.cat === binding.cardCat);
        if (!originalCard) throw new Error(`找不到卡牌: ${binding.cardName}`);
        const card = resolveNormalCard(originalCard, cardsData);
        const relpath = resolveTresRelPath(card);
        if (!relpath) throw new Error(`无法解析卡牌路径: ${card.name}`);

        // Get image dimensions
        const imgInfo = await new Promise((resolve, reject) => {
          Image.getSize(img.uri, (w, h) => resolve({ w, h }), reject);
        });

        // Calculate crop and resize to card dimensions
        const crop = calculateCrop(imgInfo.w, imgInfo.h, card.w, card.h, binding.transform || { x:0, y:0, scale:1 });
        // Clamp crop to image bounds
        const cx = Math.max(0, crop.originX);
        const cy = Math.max(0, crop.originY);
        const cw = Math.min(crop.width, imgInfo.w - cx);
        const ch = Math.min(crop.height, imgInfo.h - cy);

        const manipResult = await ImageManipulator.manipulateAsync(
          img.uri,
          [{ crop: { originX: cx, originY: cy, width: cw, height: ch } }, { resize: { width: card.w, height: card.h } }],
          { format: ImageManipulator.SaveFormat.PNG }
        );

        const pngBase64 = await FileSystem.readAsStringAsync(manipResult.uri, { encoding: 'base64' });
        await FileSystem.deleteAsync(manipResult.uri, { idempotent: true });

        atlasCards.push({ imageBase64: pngBase64, card, relpath, binding });
      }

      // 2. Build atlas grid
      const COLS = 5, GAP = 1;
      const cardW = Math.max(...atlasCards.map(c => c.card.w));
      const cardH = Math.max(...atlasCards.map(c => c.card.h));
      const rows = Math.ceil(atlasCards.length / COLS);
      const totalW = COLS * cardW + (COLS - 1) * GAP;
      const totalH = rows * cardH + (rows - 1) * GAP;
      const PAD = 4; // padding around each card slot to avoid edge bleeding
      const padW = cardW + PAD * 2;
      const padH = cardH + PAD * 2;
      const padTotalW = COLS * padW + (COLS - 1) * GAP;
      const padTotalH = rows * padH + (rows - 1) * GAP;

      const atlasName = `modcard_atlas_${finalModInfo.pckName}.png`;
      const atlasSp = `res://ArtWorks/Atlas/${atlasName}`;
      const atlasUid = generateUid(atlasSp);

      // Position cards on atlas grid (with padding offset)
      const positionedCards = atlasCards.map((c, i) => {
        const col = i % COLS;
        const row = Math.floor(i / COLS);
        return { ...c, px: col * padW + PAD, py: row * padH + PAD };
      });

      setPackStep('正在构建图集...');

      // 3. Composite atlas via WebView canvas (simple paste, no transform needed)
      const atlasBase64 = await new Promise((resolve, reject) => {
        canvasCallbackRef.current = (data) => {
          canvasCallbackRef.current = null;
          resolve(data.atlasBase64);
        };
        const cardsForCanvas = positionedCards.map(c => ({
          imageBase64: c.imageBase64,
          x: c.px, y: c.py,
          w: c.card.w, h: c.card.h
        }));
        packerEngineRef.current.buildLightAtlas(padTotalW, padTotalH, cardsForCanvas);
        setTimeout(() => { if (canvasCallbackRef.current) { canvasCallbackRef.current = null; reject(new Error('Atlas build timeout')); } }, 30000);
      });

      setPackStep('正在转换图集...');

      // 4. Convert to WebP → CTEX
      const tempPngPath = FileSystem.cacheDirectory + 'temp_atlas.png';
      await FileSystem.writeAsStringAsync(tempPngPath, atlasBase64, { encoding: 'base64' });
      const webpResult = await ImageManipulator.manipulateAsync(tempPngPath, [], { format: ImageManipulator.SaveFormat.WEBP, compress: 1.0 });
      const webpBase64 = await FileSystem.readAsStringAsync(webpResult.uri, { encoding: 'base64' });
      const webpBytes = decodeBase64(webpBase64);
      await FileSystem.deleteAsync(tempPngPath, { idempotent: true });
      await FileSystem.deleteAsync(webpResult.uri, { idempotent: true });

      setPackStep('正在生成资源...');

      // 5. Build PCK files
      const filesInfo = [];
      const manifestStr = JSON.stringify({
        id: finalModInfo.pckName, name: finalModInfo.modName,
        author: finalModInfo.author, description: finalModInfo.desc,
        version: finalModInfo.version, has_pck: true
      });
      const manifestBytes = new Uint8Array(manifestStr.length);
      for (let i = 0; i < manifestStr.length; i++) manifestBytes[i] = manifestStr.charCodeAt(i);
      filesInfo.push({ godot_path: 'res://mod_manifest.json', data: manifestBytes });

      const cfgStr = 'list=[]\n';
      const cfgBytes = new Uint8Array(cfgStr.length);
      for (let i = 0; i < cfgStr.length; i++) cfgBytes[i] = cfgStr.charCodeAt(i);
      filesInfo.push({ godot_path: 'res://.godot/global_script_class_cache.cfg', data: cfgBytes });

      const importText = generateImportText(atlasName, atlasUid);
      const importBytes = new Uint8Array(importText.length);
      for (let i = 0; i < importText.length; i++) importBytes[i] = importText.charCodeAt(i);
      filesInfo.push({ godot_path: `res://ArtWorks/Atlas/${atlasName}.import`, data: importBytes });

      const ctexBytes = createCtexBuffer(padTotalW, padTotalH, webpBytes);
      const ctexHash = SparkMD5.hash(atlasSp);
      filesInfo.push({ godot_path: `res://.godot/imported/${atlasName}-${ctexHash}.ctex`, data: ctexBytes });

      const uidCacheCards = [];
      for (const c of positionedCards) {
        const tresSp = `res://images/atlases/card_atlas.sprites/${c.relpath}`;
        const hashHex = SparkMD5.hash(tresSp);
        const remapText = generateTresRemap(hashHex, c.card.name);
        const remapBytes = new Uint8Array(remapText.length);
        for (let i = 0; i < remapText.length; i++) remapBytes[i] = remapText.charCodeAt(i);
        filesInfo.push({ godot_path: `res://images/atlases/card_atlas.sprites/${c.relpath}.remap`, data: remapBytes });

        const tresUid = generateUid(tresSp);
        const tresText = generateTresFile(atlasSp, tresUid, c.px, c.py, c.card.w, c.card.h);
        const tresBytes = new Uint8Array(tresText.length);
        for (let i = 0; i < tresText.length; i++) tresBytes[i] = tresText.charCodeAt(i);
        filesInfo.push({ godot_path: `res://ArtWorks/Atlas/mod/${hashHex}-${c.card.name}.tres`, data: tresBytes });

        uidCacheCards.push({ card: c.card, relpath: c.relpath });
      }
      const uidBin = buildUidCacheBin(uidCacheCards);
      filesInfo.push({ godot_path: 'res://.godot/uid_cache.bin', data: uidBin });

      setPackStep('正在打包...');

      // 6. Create PCK + ZIP
      const pckBuffer = createPckBuffer(filesInfo);
      const zip = new JSZip();
      zip.file(`${finalModInfo.pckName}/${finalModInfo.pckName}.json`, manifestStr);
      zip.file(`${finalModInfo.pckName}/${finalModInfo.pckName}.pck`, pckBuffer);
      const zipBase64 = await zip.generateAsync({ type: 'base64' });

      const dateStr = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const outputFolder = `output/Export_${dateStr}/`;
      const fullOutputFolder = FileSystem.documentDirectory + outputFolder;
      await FileSystem.makeDirectoryAsync(fullOutputFolder, { intermediates: true });
      await FileSystem.writeAsStringAsync(fullOutputFolder + `${finalModInfo.pckName}.zip`, zipBase64, { encoding: 'base64' });

      // Save history
      await saveHistory(finalModInfo.pckName, finalModInfo, stagingImages, cardsData);

      setIsPacking(false);
      setPackStep('');
      Alert.alert('导出成功', `Mod 已保存至：\n${outputFolder}${finalModInfo.pckName}.zip`);
    } catch (e) {
      setIsPacking(false);
      setPackStep('');
      Alert.alert('封包失败', e.message || String(e));
    }
  };

  const handleRestoreHistory = async (record) => {
    if (stagingImages.length > 0) {
      Alert.alert('确认', '当前待处理区不为空，恢复历史将覆盖当前内容。是否继续？', [
        { text: '取消', style: 'cancel' },
        { text: '恢复', onPress: () => doRestore(record) }
      ]);
    } else {
      doRestore(record);
    }
  };

  const doRestore = async (record) => {
    try {
      const restored = [];
      for (const b of (record.bindings || [])) {
        const uri = b.historyUri || b.uri;
        const info = await FileSystem.getInfoAsync(uri);
        if (info.exists) {
          restored.push({ uri, name: b.name, binding: b.binding });
        }
      }
      setStagingImages(restored);
      if (record.modInfo) setModInfo(record.modInfo);
      setShowHistory(false);
      Alert.alert('恢复成功', `已恢复 ${restored.length} 张图片及其绑定关系`);
    } catch (e) {
      Alert.alert('恢复失败', e.message);
    }
  };

  const handleDeleteHistory = async (id) => {
    Alert.alert('确认', '确定删除这条导出记录吗？', [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: async () => {
        await deleteHistory(id);
        setHistoryRecords(prev => prev.filter(r => r.id !== id));
      }}
    ]);
  };

  const handleOpenHistory = async () => {
    const records = await loadHistory();
    setHistoryRecords(records);
    setShowHistory(true);
  };

  const renderItem = ({ item }) => {
    const isSelected = selectedUris.has(item.uri);
    return (
    <TouchableOpacity
      style={[styles.imageCard, isSelected && styles.selectedCard]}
      onPress={multiSelectMode ? () => toggleSelectUri(item.uri) : undefined}
      onLongPress={() => {
        if (!multiSelectMode) {
          setMultiSelectMode(true);
          setSelectedUris(new Set([item.uri]));
        }
      }}
      activeOpacity={multiSelectMode ? 0.7 : 1}
    >
      {multiSelectMode && (
        <Ionicons
          name={isSelected ? 'checkmark-circle' : 'ellipse-outline'}
          size={24}
          color="#F4A8B6"
          style={{ marginRight: 10 }}
        />
      )}
      <Image source={{ uri: item.uri }} style={styles.thumbnail} />
      <View style={styles.cardInfo}>
        <Text style={styles.fileName} numberOfLines={1}>{item.name}</Text>
        {item.binding ? (
          <View style={styles.bindingInfo}>
            <Ionicons name="link" size={14} color="#A3D9A5" />
            <Text style={styles.bindingText}>已绑定: {item.binding.cardName}{item.binding.isBeta ? ' (Beta)' : ''}</Text>
          </View>
        ) : (
          <Text style={styles.unboundText}>未绑定关系</Text>
        )}
      </View>
      {!multiSelectMode && (
        <View style={styles.actions}>
          <TouchableOpacity onPress={() => handleOpenCropper(item)} style={styles.actionBtn}>
            <Ionicons name="crop" size={24} color="#F4A8B6" />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => removeImageFromStaging(item.uri)} style={styles.actionBtn}>
            <Ionicons name="trash-outline" size={24} color="#8A7E81" />
          </TouchableOpacity>
        </View>
      )}
    </TouchableOpacity>
  );};

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerSide}>
          <TouchableOpacity
            style={{ padding: 5 }}
            onPress={() => {
              setMultiSelectMode(!multiSelectMode);
              if (multiSelectMode) setSelectedUris(new Set());
            }}
          >
            <Ionicons
              name={multiSelectMode ? 'checkmark-circle' : 'checkmark-circle-outline'}
              size={26}
              color="#F4A8B6"
            />
          </TouchableOpacity>
        </View>
        <Text style={styles.headerTitle}>关系绑定与封包 (轻量模式)</Text>
        <View style={styles.headerSide}>
          <TouchableOpacity onPress={handleOpenHistory}>
            <Ionicons name="time-outline" size={24} color="#F4A8B6" />
          </TouchableOpacity>
        </View>
      </View>

      {multiSelectMode && (
        <View style={styles.multiSelectBar}>
          <TouchableOpacity onPress={selectAll} style={styles.multiSelectBtn}>
            <Text style={styles.multiSelectBtnText}>全选</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={invertSelection} style={styles.multiSelectBtn}>
            <Text style={styles.multiSelectBtnText}>反选</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={deleteSelected} style={styles.multiSelectBtn}>
            <Text style={[styles.multiSelectBtnText, { color: '#E88A96' }]}>删除</Text>
          </TouchableOpacity>
          <Text style={{ color: '#8A7E81', marginLeft: 10, fontSize: 13 }}>
            已选 {selectedUris.size} / {stagingImages.length}
          </Text>
        </View>
      )}

      <FlatList
        data={stagingImages}
        keyExtractor={item => item.uri}
        renderItem={renderItem}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Ionicons name="images-outline" size={64} color="#D1D1D1" />
            <Text style={styles.emptyText}>预选区目前为空</Text>
            <Text style={styles.emptySubText}>请先到【文件浏览】中长按图片并选择"添加到待处理区"</Text>
          </View>
        }
      />

      {isPacking && (
        <View style={styles.packingOverlay}>
          <ActivityIndicator color="#F4A8B6" size="large" />
          <Text style={styles.packingText}>{packStep}</Text>
        </View>
      )}

      <TouchableOpacity
        style={[styles.autoBindBtn, stagingImages.length === 0 && styles.packBtnDisabled]}
        onPress={autoBindAll}
        disabled={stagingImages.length === 0}
      >
        <Text style={styles.autoBindBtnText}>🤖 自动绑定</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={[styles.packBtn, (isPacking || stagingImages.length === 0) && styles.packBtnDisabled]}
        onPress={handleStartPack}
        disabled={isPacking || stagingImages.length === 0}
      >
        {isPacking ? <ActivityIndicator color="#FFF" /> : <Text style={styles.packBtnText}>🚀 导出并封包</Text>}
      </TouchableOpacity>

      <PackerEngine
        ref={packerEngineRef}
        onProcessingComplete={() => {}}
        onLightAtlasReady={(data) => {
          if (canvasCallbackRef.current) canvasCallbackRef.current(data);
        }}
      />

      {selectedImage && (
        <CropperModal
          visible={isCropperVisible}
          image={selectedImage}
          onClose={() => setIsCropperVisible(false)}
          onSave={(bindingData) => {
            updateBinding(selectedImage.uri, bindingData);
            setIsCropperVisible(false);
          }}
        />
      )}

      <ModInfoModal
        visible={showModInfo}
        initial={modInfo}
        onClose={() => setShowModInfo(false)}
        onConfirm={doPack}
      />

      <HistoryModal
        visible={showHistory}
        records={historyRecords}
        onClose={() => setShowHistory(false)}
        onRestore={handleRestoreHistory}
        onDelete={handleDeleteHistory}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FDF6F9' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 15,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#F2E1E6'
  },
  headerTitle: { fontSize: 18, fontWeight: 'bold', color: '#4A4043', flex: 1, textAlign: 'center' },
  headerSide: { width: 44, alignItems: 'center', justifyContent: 'center' },
  imageCard: {
    flexDirection: 'row', backgroundColor: '#FFF', margin: 10, borderRadius: 12, padding: 10, alignItems: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.05, shadowRadius: 4, elevation: 2
  },
  thumbnail: { width: 60, height: 60, borderRadius: 8, backgroundColor: '#EEE' },
  cardInfo: { flex: 1, marginLeft: 15 },
  fileName: { fontSize: 16, fontWeight: '600', color: '#4A4043' },
  unboundText: { fontSize: 13, color: '#8A7E81', marginTop: 4 },
  bindingInfo: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  bindingText: { fontSize: 13, color: '#A3D9A5', marginLeft: 4, fontWeight: 'bold' },
  actions: { flexDirection: 'row' },
  actionBtn: { padding: 10 },
  emptyContainer: { alignItems: 'center', marginTop: 100, paddingHorizontal: 40 },
  emptyText: { fontSize: 18, color: '#8A7E81', marginTop: 20, fontWeight: 'bold' },
  emptySubText: { fontSize: 14, color: '#D1D1D1', marginTop: 10, textAlign: 'center' },
  packingOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.3)', justifyContent: 'center', alignItems: 'center', zIndex: 100
  },
  packingText: { color: '#FFF', marginTop: 10, fontSize: 16 },
  autoBindBtn: {
    backgroundColor: '#F4A8B6', marginHorizontal: 20, marginTop: 10, padding: 14, borderRadius: 15, alignItems: 'center',
    shadowColor: '#F4A8B6', shadowOpacity: 0.2, shadowRadius: 8, elevation: 3
  },
  autoBindBtnText: { color: '#FFF', fontSize: 16, fontWeight: 'bold' },
  packBtn: {
    backgroundColor: '#A3D9A5', margin: 20, padding: 18, borderRadius: 15, alignItems: 'center',
    shadowColor: '#A3D9A5', shadowOpacity: 0.3, shadowRadius: 10, elevation: 5
  },
  packBtnDisabled: { backgroundColor: '#D1D1D1' },
  packBtnText: { color: '#FFF', fontSize: 18, fontWeight: 'bold' },
  multiSelectBar: {
    flexDirection: 'row', alignItems: 'center', padding: 10, backgroundColor: '#F2E1E6', paddingHorizontal: 15
  },
  multiSelectBtn: { marginRight: 20, padding: 5 },
  multiSelectBtnText: { color: '#4A4043', fontWeight: 'bold', fontSize: 14 },
  selectedCard: { backgroundColor: '#FDE2E8' },
  // Modal styles
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 30 },
  modalContent: { backgroundColor: '#FFF', borderRadius: 15, padding: 20, maxHeight: '60%' },
  modalTitle: { fontSize: 20, fontWeight: 'bold', color: '#4A4043', marginBottom: 15 },
  fieldRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  fieldLabel: { width: 70, fontSize: 14, color: '#4A4043' },
  fieldInput: { flex: 1, borderWidth: 1, borderColor: '#F2E1E6', borderRadius: 8, padding: 8, fontSize: 14, color: '#4A4043', backgroundColor: '#FDF6F9' },
  modalBtns: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 15 },
  modalBtnCancel: { paddingHorizontal: 20, paddingVertical: 10, marginRight: 10 },
  modalBtnCancelText: { color: '#8A7E81', fontSize: 16 },
  modalBtnOk: { backgroundColor: '#A3D9A5', paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8 },
  modalBtnOkText: { color: '#FFF', fontSize: 16, fontWeight: 'bold' },
  // History styles
  historyItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#F2E1E6' },
  historyInfo: { flex: 1 },
  historyTime: { fontSize: 14, fontWeight: '600', color: '#4A4043' },
  historyMeta: { fontSize: 12, color: '#8A7E81', marginTop: 2 },
  historyActions: { flexDirection: 'row' },
  historyBtn: { padding: 8, marginLeft: 5 },
});
