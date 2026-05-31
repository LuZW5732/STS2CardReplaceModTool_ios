import React, { useState, useRef, useEffect } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, Image, Alert, ActivityIndicator, TextInput, Modal, ScrollView } from 'react-native';
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

function generatePngImport(cardName, sourcePath, uidStr, ctexHash) {
  return (
    `[remap]\n\n` +
    `importer="texture"\n` +
    `type="CompressedTexture2D"\n` +
    `uid="${uidStr}"\n` +
    `path="res://.godot/imported/${cardName}.png-${ctexHash}.ctex"\n` +
    `metadata={\n"vram_texture": false\n}\n\n` +
    `[deps]\n\n` +
    `source_file="${sourcePath}"\n` +
    `dest_files=["res://.godot/imported/${cardName}.png-${ctexHash}.ctex"]\n\n` +
    `[params]\n\n` +
    `compress/mode=0\ncompress/high_quality=false\ncompress/lossy_quality=1.0\n` +
    `compress/uastc_level=2\ncompress/rdo_quality_loss=0\ncompress/hdr_compression=0\n` +
    `compress/normal_map=0\ncompress/channel_pack=0\nmipmaps/generate=false\n` +
    `mipmaps/limit=-1\nroughness/mode=0\nroughness/src_normal=""\n` +
    `process/fix_alpha_border=false\nprocess/premult_alpha=false\n` +
    `process/normal_map_invert_y=false\nprocess/hdr_as_srgb=false\n` +
    `process/hdr_clamp_exposure=false\nprocess/size_limit=0\ndetect_3d/compress_to=0\n`
  );
}

function generateTresRemap(hashHex, cardName) {
  return `[remap]\n\npath="res://.godot/exported/133200997/export-${hashHex}-${cardName}.res"\n`;
}

function generateTresContent(atlasSp, uid, x, y, w, h) {
  return `[gd_resource type="AtlasTexture" load_steps=2 format=3 uid="${uid}"]\n[ext_resource type="Texture2D" path="${atlasSp}" id="1"]\n[resource]\natlas = ExtResource("1")\nregion = Rect2(${x}, ${y}, ${w}, ${h})\n`;
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

function getDupMap(stagingImages) {
  const groups = {};
  stagingImages.forEach((img, i) => {
    if (img.binding) {
      const key = `${img.binding.cardCat}|||${img.binding.cardName}|||${img.binding.isBeta ? '1' : '0'}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(i);
    }
  });
  const result = {};
  for (const [k, v] of Object.entries(groups)) {
    if (v.length > 1) result[k] = v;
  }
  return result;
}

// --- DuplicateBindingModal ---
function DuplicateBindingModal({ visible, stagingImages, cardsData, onResolve, onCancel }) {
  const dupMap = getDupMap(stagingImages);
  const dupEntries = Object.entries(dupMap); // [[key, indices], ...]
  const [currentIdx, setCurrentIdx] = useState(0);
  const [selectedImgIdx, setSelectedImgIdx] = useState(null);
  const [resolved, setResolved] = useState(new Set());
  const [userImageDim, setUserImageDim] = useState(null);
  const [atlasDims, setAtlasDims] = useState({});

  useEffect(() => {
    if (visible && dupEntries.length > 0) {
      setCurrentIdx(0);
      setSelectedImgIdx(0);
      setResolved(new Set());
      setAtlasDims({});
    }
  }, [visible]);

  const currentEntry = dupEntries[currentIdx];
  const currentKey = currentEntry ? currentEntry[0] : null;
  const currentIndices = currentEntry ? currentEntry[1] : [];
  const selectedImg = currentIndices.length > 0 && selectedImgIdx !== null && selectedImgIdx < currentIndices.length
    ? stagingImages[currentIndices[selectedImgIdx]] : null;

  // Load atlas dimensions for current conflict template's original card
  const currentBinding = selectedImg?.binding;
  const cardForPreview = currentBinding
    ? cardsData.find(c => c.id === currentBinding.cardId && c.cat === currentBinding.cardCat)
    : null;

  useEffect(() => {
    if (cardForPreview?.atlas) {
      const atlasPath = FileSystem.documentDirectory + 'root/' + cardForPreview.atlas;
      const cacheKey = cardForPreview.atlas;
      if (!atlasDims[cacheKey]) {
        Image.getSize(atlasPath,
          (w, h) => setAtlasDims(prev => ({ ...prev, [cacheKey]: { w, h } })),
          () => {}
        );
      }
    }
  }, [cardForPreview]);

  // Update preview when selected image changes
  useEffect(() => {
    if (selectedImg) {
      Image.getSize(selectedImg.uri, (w, h) => setUserImageDim({ w, h }), () => setUserImageDim(null));
    }
  }, [currentIdx, selectedImgIdx]);

  const handleConfirm = () => {
    if (selectedImgIdx === null || !currentEntry) return;
    const [key, indices] = currentEntry;
    const changes = [];
    indices.forEach((ti, j) => {
      changes.push({ index: ti, keep: j === selectedImgIdx });
    });
    setResolved(prev => new Set([...prev, key]));
    onResolve(changes);
    advanceToNext();
  };

  const handleSkip = () => { advanceToNext(); };

  const advanceToNext = () => {
    for (let i = currentIdx + 1; i < dupEntries.length; i++) {
      if (!resolved.has(dupEntries[i][0])) { setCurrentIdx(i); setSelectedImgIdx(0); return; }
    }
    for (let i = 0; i < currentIdx; i++) {
      if (!resolved.has(dupEntries[i][0])) { setCurrentIdx(i); setSelectedImgIdx(0); return; }
    }
    onResolve(null);
  };

  const handleFinish = () => {
    const unresolved = dupEntries.filter(([k]) => !resolved.has(k));
    if (unresolved.length > 0) {
      Alert.alert('确认', `还有 ${unresolved.length} 个冲突未解决，确定跳过直接封包吗？`, [
        { text: '取消', style: 'cancel' },
        { text: '确定', onPress: () => onResolve('pack') }
      ]);
    } else {
      onResolve('pack');
    }
  };

  if (!visible || dupEntries.length === 0) return null;

  // Atlas preview: crop around card region so it's centered and maximized
  const atlasKey = cardForPreview?.atlas;
  const aDims = atlasDims[atlasKey] || { w: 4032, h: 4032 };
  const prevContainer = 150;

  let atlasPreviewStyle = null;
  if (cardForPreview && cardForPreview.atlas) {
    // Focus region: card bounds with padding all around
    const padX = cardForPreview.w * 0.6;
    const padY = cardForPreview.h * 0.6;
    const focusX = Math.max(0, cardForPreview.x - padX);
    const focusY = Math.max(0, cardForPreview.y - padY);
    const focusW = Math.min(cardForPreview.w + padX * 2, aDims.w - focusX);
    const focusH = Math.min(cardForPreview.h + padY * 2, aDims.h - focusY);

    // Scale so the focus region fills the preview container
    const focusScale = prevContainer / Math.max(focusW, focusH);
    const atlasDispW = aDims.w * focusScale;
    const atlasDispH = aDims.h * focusScale;

    // Position: center the focus region in the container
    const offsetX = prevContainer / 2 - (focusX + focusW / 2) * focusScale;
    const offsetY = prevContainer / 2 - (focusY + focusH / 2) * focusScale;

    atlasPreviewStyle = {
      width: atlasDispW,
      height: atlasDispH,
      position: 'absolute',
      left: offsetX,
      top: offsetY,
    };
  }

  return (
    <Modal visible={visible} animationType="slide" transparent>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 15 }}>
        <View style={{ backgroundColor: '#FFF', borderRadius: 15, maxHeight: '92%', padding: 20 }}>
          <Text style={{ fontSize: 18, fontWeight: 'bold', color: '#4A4043', marginBottom: 8 }}>
            重复绑定检测
          </Text>
          <Text style={{ fontSize: 13, color: '#F2C78A', marginBottom: 10 }}>
            共 {dupEntries.length} 个冲突 | 已解决: {resolved.size} | 剩余: {dupEntries.length - resolved.size}
          </Text>

          {/* Selectable template list */}
          <Text style={{ fontSize: 12, color: '#8A7E81', marginBottom: 4 }}>冲突模板列表（点击选择）：</Text>
          <ScrollView style={{ maxHeight: 100, backgroundColor: '#FDF6F9', borderRadius: 8, marginBottom: 10 }}>
            {dupEntries.map(([key, indices], i) => {
              const parts = key.split('|||');
              const label = `${parts[0]} / ${parts[1]}${parts[2] === '1' ? ' (Beta)' : ''}`;
              const isCurrent = i === currentIdx;
              const isResolved = resolved.has(key);
              return (
                <TouchableOpacity
                  key={key}
                  style={{
                    flexDirection: 'row', alignItems: 'center', padding: 10,
                    backgroundColor: isCurrent ? '#FDE2E8' : 'transparent',
                    borderBottomWidth: 1, borderBottomColor: '#F2E1E6'
                  }}
                  onPress={() => { setCurrentIdx(i); setSelectedImgIdx(0); }}
                >
                  <Ionicons
                    name={isResolved ? 'checkmark-circle' : (isCurrent ? 'radio-button-on' : 'radio-button-off')}
                    size={18}
                    color={isResolved ? '#A3D9A5' : '#F4A8B6'}
                  />
                  <Text style={{ marginLeft: 8, fontSize: 13, color: isResolved ? '#A3D9A5' : '#4A4043' }} numberOfLines={1}>
                    {isResolved ? '✓ ' : '● '}{label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          {/* Current conflict detail */}
          {currentEntry && (
            <>
              <Text style={{ fontSize: 14, fontWeight: 'bold', color: '#4A4043', marginBottom: 5 }}>
                {currentKey ? currentKey.split('|||').slice(0, 2).join(' / ') : ''}
              </Text>

              <Text style={{ fontSize: 12, color: '#8A7E81', marginBottom: 5 }}>绑定该模板的图片（点击选择保留项）：</Text>
              <ScrollView style={{ maxHeight: 120, backgroundColor: '#FDF6F9', borderRadius: 8, marginBottom: 10 }}>
                {currentIndices.map((ti, j) => {
                  const img = stagingImages[ti];
                  const isSel = j === selectedImgIdx;
                  return (
                    <TouchableOpacity
                      key={j}
                      style={{ flexDirection: 'row', alignItems: 'center', padding: 10, backgroundColor: isSel ? '#FFD4D4' : 'transparent', borderBottomWidth: 1, borderBottomColor: '#F2E1E6' }}
                      onPress={() => setSelectedImgIdx(j)}
                    >
                      <Ionicons name={isSel ? 'radio-button-on' : 'radio-button-off'} size={20} color="#F4A8B6" />
                      <Text style={{ marginLeft: 8, fontSize: 13, color: '#4A4043' }} numberOfLines={1}>{img.name}</Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>

              {/* Previews */}
              <View style={{ flexDirection: 'row', justifyContent: 'space-around', marginBottom: 15 }}>
                <View style={{ alignItems: 'center', flex: 1 }}>
                  <Text style={{ fontSize: 11, color: '#8A7E81', marginBottom: 4 }}>替换图片</Text>
                  {selectedImg ? (
                    <Image source={{ uri: selectedImg.uri }} style={{ width: 150, height: 150, borderRadius: 8, resizeMode: 'contain', backgroundColor: '#EEE' }} />
                  ) : (
                    <View style={{ width: 150, height: 150, borderRadius: 8, backgroundColor: '#EEE', justifyContent: 'center', alignItems: 'center' }}>
                      <Ionicons name="image-outline" size={40} color="#D1D1D1" />
                    </View>
                  )}
                  {userImageDim && <Text style={{ fontSize: 10, color: '#8A7E81', marginTop: 2 }}>{userImageDim.w}x{userImageDim.h}</Text>}
                </View>
                <View style={{ alignItems: 'center', flex: 1 }}>
                  <Text style={{ fontSize: 11, color: '#8A7E81', marginBottom: 4 }}>原卡图</Text>
                  {atlasPreviewStyle ? (
                    <View style={{ width: prevContainer, height: prevContainer, borderRadius: 8, overflow: 'hidden', backgroundColor: '#EEE' }}>
                      <Image
                        source={{ uri: FileSystem.documentDirectory + 'root/' + cardForPreview.atlas }}
                        style={atlasPreviewStyle}
                      />
                    </View>
                  ) : (
                    <View style={{ width: 150, height: 150, borderRadius: 8, backgroundColor: '#EEE', justifyContent: 'center', alignItems: 'center' }}>
                      <Ionicons name="card" size={40} color="#D1D1D1" />
                    </View>
                  )}
                  {cardForPreview && (
                    <Text style={{ fontSize: 10, color: '#8A7E81', marginTop: 2 }}>
                      模板: {cardForPreview.name} {cardForPreview.w}x{cardForPreview.h}
                    </Text>
                  )}
                </View>
              </View>
            </>
          )}

          {/* Buttons */}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <View style={{ flexDirection: 'row' }}>
              <TouchableOpacity onPress={handleConfirm} style={{ backgroundColor: '#A3D9A5', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8, marginRight: 8 }}>
                <Text style={{ color: '#FFF', fontWeight: 'bold' }}>确认关系</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={handleSkip} style={{ backgroundColor: '#F0E4E8', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8 }}>
                <Text style={{ color: '#4A4043', fontWeight: 'bold' }}>跳过</Text>
              </TouchableOpacity>
            </View>
            <View style={{ flexDirection: 'row' }}>
              <TouchableOpacity onPress={onCancel} style={{ backgroundColor: '#F0E4E8', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8, marginRight: 8 }}>
                <Text style={{ color: '#4A4043' }}>返回</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={handleFinish} style={{ backgroundColor: '#A3D9A5', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8 }}>
                <Text style={{ color: '#FFF', fontWeight: 'bold' }}>全部解决，进行封包</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
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

// --- Main Component ---

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

async function saveHistory(pckName, modInfo, stagingImages) {
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
    bindings: stagingImages.map(img => ({
      name: img.name,
      uri: img.uri,
      binding: img.binding ? { ...img.binding } : null
    }))
  };
  for (const img of stagingImages) {
    const destName = `${id}_${img.name}`;
    try {
      const destInfo = await FileSystem.getInfoAsync(HISTORY_DIR + destName);
      if (!destInfo.exists) {
        await FileSystem.copyAsync({ from: img.uri, to: HISTORY_DIR + destName });
      }
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
    for (const b of (record.bindings || [])) {
      if (b.historyUri) await FileSystem.deleteAsync(b.historyUri, { idempotent: true });
    }
  } catch (e) {}
  await FileSystem.deleteAsync(jsonPath, { idempotent: true });
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

export default function BindingScreen() {
  const { stagingImages, setStagingImages, cardsData, removeImageFromStaging, updateBinding } = useBindings();
  const [selectedImage, setSelectedImage] = useState(null);
  const [isCropperVisible, setIsCropperVisible] = useState(false);
  const [isPacking, setIsPacking] = useState(false);
  const [packStep, setPackStep] = useState('');
  const [showModInfo, setShowModInfo] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showDupModal, setShowDupModal] = useState(false);
  const [modInfo, setModInfo] = useState({ pckName: 'CardReplaceMod1', modName: 'STS2 iOS Mod', author: '', desc: '', version: '1.0.0' });
  const [historyRecords, setHistoryRecords] = useState([]);
  const [multiSelectMode, setMultiSelectMode] = useState(false);
  const [selectedUris, setSelectedUris] = useState(new Set());
  const packerEngineRef = useRef(null);

  const handleOpenCropper = (image) => {
    setSelectedImage(image);
    setIsCropperVisible(true);
  };

  const autoBindAll = () => {
    if (stagingImages.length === 0) {
      Alert.alert('提示', '没有可绑定的图片，请先从文件浏览中添加！');
      return;
    }
    let successCount = 0;
    const failList = [];
    const newImages = stagingImages.map(img => {
      if (img.binding) return img;
      const key = extractKey(img.name);
      if (!key) { failList.push(img.name); return img; }
      const nKey = norm(key);
      let bestMatch = null;
      for (const c of cardsData) {
        const rn = norm(c.name);
        if (rn && rn.length > 0 && nKey.includes(rn)) {
          if (!bestMatch || rn.length > norm(bestMatch.name).length) bestMatch = c;
        }
      }
      if (bestMatch) {
        const sameNameCount = cardsData.filter(c => norm(c.name) === norm(bestMatch.name)).length;
        if (sameNameCount > 1) { failList.push(img.name); return img; }
        successCount++;
        return { ...img, binding: { cardId: bestMatch.id, cardName: bestMatch.name, cardCat: bestMatch.cat, isBeta: bestMatch.is_beta || false, atlas: bestMatch.atlas, rect: { x: bestMatch.x, y: bestMatch.y, w: bestMatch.w, h: bestMatch.h }, transform: { x: 0, y: 0, scale: 1 } } };
      }
      failList.push(img.name); return img;
    });
    setStagingImages(newImages);
    if (failList.length === 0) {
      Alert.alert('自动绑定完成', `全部 ${successCount} 张图片已成功绑定！`);
    } else {
      Alert.alert('自动绑定结果', `成功绑定: ${successCount} 个\n未能绑定: ${failList.length} 个\n\n以下图片未能自动绑定：\n${failList.join('\n')}`);
    }
  };

  const selectAll = () => { setSelectedUris(new Set(stagingImages.map(img => img.uri))); };
  const invertSelection = () => {
    const newSel = new Set();
    stagingImages.forEach(img => { if (!selectedUris.has(img.uri)) newSel.add(img.uri); });
    setSelectedUris(newSel);
  };
  const deleteSelected = () => {
    if (selectedUris.size === 0) return;
    Alert.alert('确认', `确定要删除选中的 ${selectedUris.size} 个项目吗？`, [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: () => {
          setStagingImages(stagingImages.filter(img => !selectedUris.has(img.uri)));
          setSelectedUris(new Set()); setMultiSelectMode(false);
      }}
    ]);
  };
  const toggleSelectUri = (uri) => {
    const newSel = new Set(selectedUris);
    if (newSel.has(uri)) newSel.delete(uri); else newSel.add(uri);
    setSelectedUris(newSel);
  };

  // --- Pack logic: independent file mode ---
  const handleStartPack = async () => {
    const boundOnes = stagingImages.filter(img => img.binding);
    if (boundOnes.length === 0) { Alert.alert("提示", "请至少绑定一张卡牌后再导出"); return; }

    // Check duplicates
    const dupMap = getDupMap(stagingImages);
    if (Object.keys(dupMap).length > 0) {
      setShowDupModal(true);
      return;
    }
    setShowModInfo(true);
  };

  const handleDupResolve = (result) => {
    setShowDupModal(false);
    if (result === null) {
      // All resolved — do nothing, user will press pack again
      Alert.alert('解决完成', '所有冲突已解决，请再次点击封包按钮。');
      return;
    }
    if (result === 'pack') {
      // Proceed to pack
      setShowModInfo(true);
      return;
    }
    if (Array.isArray(result)) {
      // result is [{index, keep}, ...]
      const newImages = [...stagingImages];
      result.forEach(({ index, keep }) => {
        if (!keep) newImages[index] = { ...newImages[index], binding: null };
      });
      setStagingImages(newImages);
    }
  };

  const doPack = async (finalModInfo) => {
    setShowModInfo(false);
    const boundOnes = stagingImages.filter(img => img.binding);
    if (boundOnes.length === 0) return;

    // Re-check duplicates
    const dupMap = getDupMap(stagingImages);
    if (Object.keys(dupMap).length > 0) {
      Alert.alert('仍有冲突', '还有未解决的重复绑定，请先处理。');
      setShowDupModal(true);
      return;
    }

    setIsPacking(true);
    setModInfo(finalModInfo);
    try {
      // 1. Process each image: crop to ratio, keep original resolution
      setPackStep('正在处理图片...');
      const atlasCards = [];
      for (const img of boundOnes) {
        const binding = img.binding;
        const originalCard = cardsData.find(c => c.id === binding.cardId && c.cat === binding.cardCat);
        if (!originalCard) throw new Error(`找不到卡牌: ${binding.cardName}`);
        const card = resolveNormalCard(originalCard, cardsData);
        const catPath = card.cat.replace(/ \/ /g, '/');
        if (catPath === '未分类') throw new Error(`无法解析卡牌分类: ${card.name}`);
        const relpath = `${catPath}/${card.name}.tres`;

        // Get image dimensions
        const imgInfo = await new Promise((resolve, reject) => {
          Image.getSize(img.uri, (w, h) => resolve({ w, h }), reject);
        });

        // Crop to match card ratio, keeping original resolution
        const targetRatio = card.w / card.h;
        const imgRatio = imgInfo.w / imgInfo.h;
        let cropOriginX = 0, cropOriginY = 0, cropW = imgInfo.w, cropH = imgInfo.h;
        if (Math.abs(imgRatio - targetRatio) > 0.005) {
          if (imgRatio > targetRatio) {
            cropW = Math.round(imgInfo.h * targetRatio);
            cropOriginX = Math.round((imgInfo.w - cropW) / 2);
            cropH = imgInfo.h;
          } else {
            cropH = Math.round(imgInfo.w / targetRatio);
            cropOriginY = Math.round((imgInfo.h - cropH) / 2);
            cropW = imgInfo.w;
          }
        }
        // Clamp to image bounds
        cropOriginX = Math.max(0, cropOriginX);
        cropOriginY = Math.max(0, cropOriginY);
        cropW = Math.min(cropW, imgInfo.w - cropOriginX);
        cropH = Math.min(cropH, imgInfo.h - cropOriginY);

        const manipResult = await ImageManipulator.manipulateAsync(
          img.uri,
          [{ crop: { originX: cropOriginX, originY: cropOriginY, width: cropW, height: cropH } }],
          { format: ImageManipulator.SaveFormat.PNG }
        );

        const pngBase64 = await FileSystem.readAsStringAsync(manipResult.uri, { encoding: 'base64' });
        await FileSystem.deleteAsync(manipResult.uri, { idempotent: true });

        // Get actual cropped dimensions
        const croppedW = cropW;
        const croppedH = cropH;

        atlasCards.push({
          imageBase64: pngBase64,
          card,
          relpath,
          catPath,
          binding,
          imgW: croppedW,
          imgH: croppedH
        });
      }

      setPackStep('正在生成文件...');

      const filesInfo = [];
      const uidCacheCards = [];

      // Manifest
      const manifestStr = JSON.stringify({
        id: finalModInfo.pckName, name: finalModInfo.modName,
        author: finalModInfo.author, description: finalModInfo.desc,
        version: finalModInfo.version, has_pck: true
      });
      const manifestBytes = new Uint8Array(manifestStr.length);
      for (let i = 0; i < manifestStr.length; i++) manifestBytes[i] = manifestStr.charCodeAt(i);
      filesInfo.push({ godot_path: 'res://mod_manifest.json', data: manifestBytes });

      const cfgBytes = new Uint8Array(8);
      for (let i = 0; i < 8; i++) cfgBytes[i] = 'list=[]\n'.charCodeAt(i);
      filesInfo.push({ godot_path: 'res://.godot/global_script_class_cache.cfg', data: cfgBytes });

      for (const c of atlasCards) {
        // Convert PNG base64 to WebP bytes — use ImageManipulator to get WebP
        const tempPngPath = FileSystem.cacheDirectory + 'temp_card.png';
        await FileSystem.writeAsStringAsync(tempPngPath, c.imageBase64, { encoding: 'base64' });
        const webpResult = await ImageManipulator.manipulateAsync(tempPngPath, [], { format: ImageManipulator.SaveFormat.WEBP, compress: 1.0 });
        const webpBase64 = await FileSystem.readAsStringAsync(webpResult.uri, { encoding: 'base64' });
        const webpBytes = decodeBase64(webpBase64);
        await FileSystem.deleteAsync(tempPngPath, { idempotent: true });
        await FileSystem.deleteAsync(webpResult.uri, { idempotent: true });

        // PNG reference path
        const relPng = `res://images/packed/card_portraits/${c.catPath}/${c.card.name}.png`;
        const pngUid = generateUid(relPng);
        const ctexData = createCtexBuffer(c.imgW, c.imgH, webpBytes);
        const ctexHash = SparkMD5.hash(relPng);

        // .png.import
        const impText = generatePngImport(c.card.name, relPng, pngUid, ctexHash);
        const impBytes = new Uint8Array(impText.length);
        for (let i = 0; i < impText.length; i++) impBytes[i] = impText.charCodeAt(i);
        filesInfo.push({ godot_path: `res://images/packed/card_portraits/${c.catPath}/${c.card.name}.png.import`, data: impBytes });

        // .ctex
        filesInfo.push({ godot_path: `res://.godot/imported/${c.card.name}.png-${ctexHash}.ctex`, data: ctexData });

        // .tres.remap
        const tresSp = `res://images/atlases/card_atlas.sprites/${c.relpath}`;
        const hashHex = SparkMD5.hash(tresSp);
        const remapText = generateTresRemap(hashHex, c.card.name);
        const remapBytes = new Uint8Array(remapText.length);
        for (let i = 0; i < remapText.length; i++) remapBytes[i] = remapText.charCodeAt(i);
        filesInfo.push({ godot_path: `res://images/atlases/card_atlas.sprites/${c.relpath}.remap`, data: remapBytes });

        // .res (references individual PNG, region=(0,0,w,h))
        const tresUid = generateUid(tresSp);
        const tresText = generateTresContent(relPng, tresUid, 0, 0, c.imgW, c.imgH);
        const tresBytes = new Uint8Array(tresText.length);
        for (let i = 0; i < tresText.length; i++) tresBytes[i] = tresText.charCodeAt(i);
        filesInfo.push({ godot_path: `res://.godot/exported/133200997/export-${hashHex}-${c.card.name}.res`, data: tresBytes });

        uidCacheCards.push({ card: c.card, relpath: c.relpath });
      }

      // uid_cache.bin
      const uidBin = buildUidCacheBin(uidCacheCards);
      filesInfo.push({ godot_path: 'res://.godot/uid_cache.bin', data: uidBin });

      setPackStep('正在打包...');

      // Create PCK + ZIP
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

      await saveHistory(finalModInfo.pckName, finalModInfo, stagingImages);

      setIsPacking(false);
      setPackStep('');
      Alert.alert('导出成功', `Mod 已保存至：\n${outputFolder}${finalModInfo.pckName}.zip`);
    } catch (e) {
      setIsPacking(false);
      setPackStep('');
      Alert.alert('封包失败', e.message || String(e));
    }
  };

  // --- History ---
  const handleRestoreHistory = async (record) => {
    if (stagingImages.length > 0) {
      Alert.alert('确认', '当前待处理区不为空，恢复历史将覆盖当前内容。是否继续？', [
        { text: '取消', style: 'cancel' },
        { text: '恢复', onPress: () => doRestore(record) }
      ]);
    } else { doRestore(record); }
  };

  const doRestore = async (record) => {
    try {
      const restored = [];
      for (const b of (record.bindings || [])) {
        const uri = b.historyUri || b.uri;
        const info = await FileSystem.getInfoAsync(uri);
        if (info.exists) restored.push({ uri, name: b.name, binding: b.binding });
      }
      setStagingImages(restored);
      if (record.modInfo) setModInfo(record.modInfo);
      setShowHistory(false);
      Alert.alert('恢复成功', `已恢复 ${restored.length} 张图片及其绑定关系`);
    } catch (e) { Alert.alert('恢复失败', e.message); }
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

  // --- Render ---
  const dupMap = getDupMap(stagingImages);
  const dupIndices = new Set();
  Object.values(dupMap).forEach(arr => arr.forEach(i => dupIndices.add(i)));

  const renderItem = ({ item, index }) => {
    const isSelected = selectedUris.has(item.uri);
    const isDup = dupIndices.has(index);
    return (
      <TouchableOpacity
        style={[styles.imageCard, isSelected && styles.selectedCard]}
        onPress={multiSelectMode ? () => toggleSelectUri(item.uri) : undefined}
        onLongPress={() => { if (!multiSelectMode) { setMultiSelectMode(true); setSelectedUris(new Set([item.uri])); } }}
        activeOpacity={multiSelectMode ? 0.7 : 1}
      >
        {multiSelectMode && (
          <Ionicons name={isSelected ? 'checkmark-circle' : 'ellipse-outline'} size={24} color="#F4A8B6" style={{ marginRight: 10 }} />
        )}
        <Image source={{ uri: item.uri }} style={styles.thumbnail} />
        <View style={styles.cardInfo}>
          <Text style={[styles.fileName, isDup && styles.dupFileName]} numberOfLines={1}>
            {isDup ? '⚠️ ' : ''}{item.name}
          </Text>
          {item.binding ? (
            <View style={styles.bindingInfo}>
              <Ionicons name="link" size={14} color={isDup ? '#F2C78A' : '#A3D9A5'} />
              <Text style={[styles.bindingText, isDup && { color: '#F2C78A' }]}>
                已绑定: {item.binding.cardName}{item.binding.isBeta ? ' (Beta)' : ''}
              </Text>
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
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerSide}>
          <TouchableOpacity
            style={{ padding: 5 }}
            onPress={() => { setMultiSelectMode(!multiSelectMode); if (multiSelectMode) setSelectedUris(new Set()); }}
          >
            <Ionicons name={multiSelectMode ? 'checkmark-circle' : 'checkmark-circle-outline'} size={26} color="#F4A8B6" />
          </TouchableOpacity>
        </View>
        <Text style={styles.headerTitle}>关系绑定与封包 (独立卡图模式)</Text>
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
        <Text style={styles.autoBindBtnText}>自动绑定</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={[styles.packBtn, (isPacking || stagingImages.length === 0) && styles.packBtnDisabled]}
        onPress={handleStartPack}
        disabled={isPacking || stagingImages.length === 0}
      >
        {isPacking ? <ActivityIndicator color="#FFF" /> : <Text style={styles.packBtnText}>导出并封包</Text>}
      </TouchableOpacity>

      <PackerEngine ref={packerEngineRef} onProcessingComplete={() => {}} onLightAtlasReady={() => {}} />

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

      <ModInfoModal visible={showModInfo} initial={modInfo} onClose={() => setShowModInfo(false)} onConfirm={doPack} />

      <HistoryModal visible={showHistory} records={historyRecords} onClose={() => setShowHistory(false)} onRestore={handleRestoreHistory} onDelete={handleDeleteHistory} />

      <DuplicateBindingModal visible={showDupModal} stagingImages={stagingImages} cardsData={cardsData} onResolve={handleDupResolve} onCancel={() => setShowDupModal(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FDF6F9' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: 15, backgroundColor: '#FFFFFF', borderBottomWidth: 1, borderBottomColor: '#F2E1E6'
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
  dupFileName: { color: '#F2C78A' },
  unboundText: { fontSize: 13, color: '#8A7E81', marginTop: 4 },
  bindingInfo: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  bindingText: { fontSize: 13, color: '#A3D9A5', marginLeft: 4, fontWeight: 'bold' },
  actions: { flexDirection: 'row' },
  actionBtn: { padding: 10 },
  emptyContainer: { alignItems: 'center', marginTop: 100, paddingHorizontal: 40 },
  emptyText: { fontSize: 18, color: '#8A7E81', marginTop: 20, fontWeight: 'bold' },
  emptySubText: { fontSize: 14, color: '#D1D1D1', marginTop: 10, textAlign: 'center' },
  packingOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.3)', justifyContent: 'center', alignItems: 'center', zIndex: 100 },
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
  multiSelectBar: { flexDirection: 'row', alignItems: 'center', padding: 10, backgroundColor: '#F2E1E6', paddingHorizontal: 15 },
  multiSelectBtn: { marginRight: 20, padding: 5 },
  multiSelectBtnText: { color: '#4A4043', fontWeight: 'bold', fontSize: 14 },
  selectedCard: { backgroundColor: '#FDE2E8' },
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
  historyItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#F2E1E6' },
  historyInfo: { flex: 1 },
  historyTime: { fontSize: 14, fontWeight: '600', color: '#4A4043' },
  historyMeta: { fontSize: 12, color: '#8A7E81', marginTop: 2 },
  historyActions: { flexDirection: 'row' },
  historyBtn: { padding: 8, marginLeft: 5 },
});
