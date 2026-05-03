import React, { useState, useEffect, useLayoutEffect } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, Alert, ActionSheetIOS, Platform, Modal, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system/legacy';
import JSZip from 'jszip';
import { rootDir, listFiles, ensureDir, deleteFile, copyFile, moveFile } from '../utils/fs';
import { unpackPck } from '../utils/unpacker';
import { useBindings } from '../utils/BindingContext';

// Simple Image Preview Modal
const ImagePreviewModal = ({ visible, uri, onClose }) => {
  if (!uri) return null;
  return (
    <Modal visible={visible} transparent={true} animationType="fade">
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.9)', justifyContent: 'center', alignItems: 'center' }}>
        <TouchableOpacity style={{ position: 'absolute', top: 50, right: 20, zIndex: 1 }} onPress={onClose}>
          <Ionicons name="close-circle" size={40} color="#FFF" />
        </TouchableOpacity>
        <Image source={{ uri }} style={{ width: '100%', height: '80%', resizeMode: 'contain' }} />
      </View>
    </Modal>
  );
};

export default function FileBrowserScreen() {
  const { addImageToStaging } = useBindings();
  const [currentPath, setCurrentPath] = useState(rootDir);
  const [files, setFiles] = useState([]);
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState(new Set());
  const [previewUri, setPreviewUri] = useState(null);
  const [clipboard, setClipboard] = useState(null); // { action: 'copy' | 'cut', files: [{path, name}] }

  const loadFiles = async () => {
    const fetchedFiles = await listFiles(currentPath);
    setFiles(fetchedFiles);
  };

  useEffect(() => {
    loadFiles();
  }, [currentPath]);

  const handleImportMenu = () => {
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ['取消', '从相册导入图像', '导入文件'],
          cancelButtonIndex: 0,
        },
        (buttonIndex) => {
          if (buttonIndex === 1) importImage();
          else if (buttonIndex === 2) importPck();
        }
      );
    } else {
      Alert.alert('导入', '请选择导入类型', [
        { text: '从相册导入图像', onPress: importImage },
        { text: '导入文件', onPress: importPck },
        { text: '取消', style: 'cancel' }
      ]);
    }
  };

  const importImage = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 1,
    });
    if (!result.canceled) {
      const uri = result.assets[0].uri;
      const fileName = uri.split('/').pop() || `image_${Date.now()}.png`;
      await copyFile(uri, currentPath + fileName);
      loadFiles();
    }
  };

  const importPck = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
    });
    if (result.canceled) return;
    const { uri, name } = result.assets[0];
    await copyFile(uri, currentPath + name);
    loadFiles();
  };

  const handlePressFile = (file) => {
    if (isSelectionMode) {
      const newSel = new Set(selectedFiles);
      if (newSel.has(file.name)) newSel.delete(file.name);
      else newSel.add(file.name);
      setSelectedFiles(newSel);
      return;
    }

    if (file.isDirectory) {
      setCurrentPath(file.path + '/');
    } else {
      const isImage = /\.(png|jpg|jpeg|webp|bmp)$/i.test(file.name);
      if (isImage) {
        setPreviewUri(file.path);
      } else {
        handleLongPressFile(file);
      }
    }
  };

  const handleLongPressFile = (file) => {
    const options = ['取消', '分享', '复制', '剪切', '删除', '重命名'];
    
    // Add "Add to Staging" for images
    const isImage = /\.(png|jpg|jpeg|webp|bmp)$/i.test(file.name);
    if (isImage) {
      options.splice(1, 0, '添加到待处理区');
    }

    if (file.name.toLowerCase().endsWith('.pck')) {
      options.splice(1, 0, '解包 PCK');
    }
    if (/\.(zip|rar)$/i.test(file.name)) {
      options.splice(1, 0, '解压缩');
    } else {
      options.splice(1, 0, '压缩');
    }

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options,
          cancelButtonIndex: 0,
          destructiveButtonIndex: options.indexOf('删除'),
        },
        async (btnIdx) => {
          const title = options[btnIdx];
          await executeFileAction(title, file);
        }
      );
    }
  };

  const executeFileAction = async (action, file) => {
    try {
      if (action === '删除') {
        await deleteFile(file.path);
        loadFiles();
      } else if (action === '分享') {
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(file.path);
        }
      } else if (action === '添加到待处理区') {
        addImageToStaging(file.path, file.name);
        Alert.alert("成功", "已添加到关系绑定区");
      } else if (action === '复制') {
        setClipboard({ action: 'copy', files: [{ path: file.path, name: file.name }] });
      } else if (action === '剪切') {
        setClipboard({ action: 'cut', files: [{ path: file.path, name: file.name }] });
      } else if (action === '解包 PCK') {
        const outDirName = `Unpacked_${file.name.replace(/\.pck$/i, '')}_${Date.now()}`;
        const outDir = file.path.substring(0, file.path.lastIndexOf('/') + 1) + outDirName;
        
        Alert.alert("解包中", "正在解析并还原资源，请稍候...");
        try {
          const count = await unpackPck(file.path, outDir);
          loadFiles();
          Alert.alert("成功", `成功解包并还原了 ${count} 个资源！`);
        } catch (e) {
          Alert.alert("解包失败", e.message);
        }
      } else if (action === '解压缩') {
        const outDir = file.path.substring(0, file.path.lastIndexOf('/') + 1);
        
        Alert.alert("解压中", "正在解压缩文件，请稍候...");
        try {
          const zipData = await FileSystem.readAsStringAsync(file.path, { encoding: 'base64' });
          const zip = await JSZip.loadAsync(zipData, { base64: true });
          
          let count = 0;
          for (const [filename, zipEntry] of Object.entries(zip.files)) {
            if (zipEntry.dir) {
              await ensureDir(outDir + filename);
              continue;
            }
            // Ensure parent directory of file exists
            const entryParts = filename.split('/');
            entryParts.pop();
            if (entryParts.length > 0) {
              await ensureDir(outDir + entryParts.join('/'));
            }
            
            const contentBase64 = await zipEntry.async("base64");
            await FileSystem.writeAsStringAsync(outDir + filename, contentBase64, { encoding: 'base64' });
            count++;
          }
          
          loadFiles();
          Alert.alert("解压成功", `成功解压了 ${count} 个文件到当前目录！`);
        } catch (e) {
          Alert.alert("解压失败", e.message);
        }
      } else if (action === '压缩') {
        Alert.alert("压缩中", "正在打包文件，请稍候...");
        try {
          const zip = new JSZip();
          const addDirToZip = async (dirPath, zipFolder) => {
            const items = await FileSystem.readDirectoryAsync(dirPath);
            for (const item of items) {
              const fullPath = dirPath + '/' + item;
              const info = await FileSystem.getInfoAsync(fullPath);
              if (info.isDirectory) {
                await addDirToZip(fullPath, zipFolder.folder(item));
              } else {
                const content = await FileSystem.readAsStringAsync(fullPath, { encoding: 'base64' });
                zipFolder.file(item, content, { base64: true });
              }
            }
          };

          if (file.isDirectory) {
            await addDirToZip(file.path, zip.folder(file.name));
          } else {
            const content = await FileSystem.readAsStringAsync(file.path, { encoding: 'base64' });
            zip.file(file.name, content, { base64: true });
          }

          const base64Zip = await zip.generateAsync({ type: 'base64' });
          const outPath = file.path.substring(0, file.path.lastIndexOf('/')) + '/' + file.name + '.zip';
          await FileSystem.writeAsStringAsync(outPath, base64Zip, { encoding: 'base64' });
          loadFiles();
          Alert.alert("压缩成功", `已生成压缩包：${file.name}.zip`);
        } catch (e) {
          Alert.alert("压缩失败", e.message);
        }
      }
      // TODO: rename
    } catch(e) {
      Alert.alert("错误", e.message);
    }
  };

  const renderItem = ({ item }) => {
    const isSelected = selectedFiles.has(item.name);
    return (
      <TouchableOpacity 
        style={[styles.fileRow, isSelected && styles.selectedRow]}
        onPress={() => handlePressFile(item)}
        onLongPress={() => handleLongPressFile(item)}
      >
        <Ionicons 
          name={item.isDirectory ? "folder" : (item.name.endsWith('.pck') ? "cube" : "image")} 
          size={32} 
          color={item.isDirectory ? "#F2C78A" : "#8A7E81"} 
          style={{ marginRight: 15 }}
        />
        <View style={{ flex: 1 }}>
          <Text style={styles.fileName} numberOfLines={1}>{item.name}</Text>
          <Text style={styles.fileMeta}>{item.isDirectory ? '文件夹' : (item.size / 1024).toFixed(1) + ' KB'}</Text>
        </View>
        {isSelectionMode && (
          <Ionicons name={isSelected ? "checkmark-circle" : "ellipse-outline"} size={24} color="#F4A8B6" />
        )}
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      {/* Custom Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          {currentPath !== rootDir && (
            <TouchableOpacity 
              onPress={() => {
                const parts = currentPath.replace(/\/$/, '').split('/');
                parts.pop();
                setCurrentPath(parts.join('/') + '/');
              }} 
            >
              <Ionicons name="arrow-back" size={26} color="#F4A8B6" />
            </TouchableOpacity>
          )}
        </View>
        
        <Text style={styles.headerTitle} numberOfLines={1}>
          {currentPath === rootDir ? '文件浏览' : currentPath.split('/').filter(Boolean).pop()}
        </Text>

        <View style={styles.headerRight}>
          {clipboard && clipboard.files.length > 0 && (
            <TouchableOpacity onPress={async () => {
              try {
                for (const f of clipboard.files) {
                  const toPath = currentPath + f.name;
                  if (clipboard.action === 'cut') {
                    await moveFile(f.path, toPath);
                  } else {
                    await copyFile(f.path, toPath);
                  }
                }
                if (clipboard.action === 'cut') setClipboard(null);
                loadFiles();
              } catch (e) {
                Alert.alert("粘贴失败", e.message);
              }
            }} style={{ marginRight: 15 }}>
              <Ionicons name="clipboard-outline" size={26} color="#F4A8B6" />
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={handleImportMenu} style={{ marginRight: 15 }}>
            <Ionicons name="add-circle-outline" size={26} color="#F4A8B6" />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setIsSelectionMode(!isSelectionMode)}>
            <Ionicons name={isSelectionMode ? "checkmark-circle" : "checkmark-circle-outline"} size={26} color="#F4A8B6" />
          </TouchableOpacity>
        </View>
      </View>

      {isSelectionMode && selectedFiles.size > 0 && (
        <View style={styles.batchBar}>
          <TouchableOpacity onPress={() => {
            const arr = Array.from(selectedFiles);
            let addedCount = 0;
            arr.forEach(name => {
              const file = files.find(f => f.name === name);
              if (file && /\.(png|jpg|jpeg|webp|bmp)$/i.test(file.name)) {
                addImageToStaging(file.path, file.name);
                addedCount++;
              }
            });
            if (addedCount > 0) Alert.alert("成功", `已批量添加 ${addedCount} 张图片到待处理区！`);
            setIsSelectionMode(false);
            setSelectedFiles(new Set());
          }} style={{marginRight: 20}}>
            <Text style={{color: '#A3D9A5', fontWeight: 'bold'}}>批量添加图片</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => {
            const arr = Array.from(selectedFiles);
            const filesToClip = arr.map(name => {
              const file = files.find(f => f.name === name);
              return { path: file.path, name: file.name };
            }).filter(Boolean);
            setClipboard({ action: 'copy', files: filesToClip });
            setIsSelectionMode(false);
            setSelectedFiles(new Set());
          }} style={{marginRight: 20}}>
            <Text style={{color: '#8A7E81', fontWeight: 'bold'}}>复制</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => {
            const arr = Array.from(selectedFiles);
            const filesToClip = arr.map(name => {
              const file = files.find(f => f.name === name);
              return { path: file.path, name: file.name };
            }).filter(Boolean);
            setClipboard({ action: 'cut', files: filesToClip });
            setIsSelectionMode(false);
            setSelectedFiles(new Set());
          }} style={{marginRight: 20}}>
            <Text style={{color: '#8A7E81', fontWeight: 'bold'}}>剪切</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={async () => {
            Alert.alert('确认', `确定要删除选中的 ${selectedFiles.size} 个项目吗？`, [
              { text: '取消', style: 'cancel' },
              { text: '删除', style: 'destructive', onPress: async () => {
                  for (const name of selectedFiles) {
                    const file = files.find(f => f.name === name);
                    if (file) await deleteFile(file.path);
                  }
                  setSelectedFiles(new Set());
                  setIsSelectionMode(false);
                  loadFiles();
              }}
            ]);
          }}>
            <Text style={{color: '#F4A8B6', fontWeight: 'bold'}}>删除选中</Text>
          </TouchableOpacity>
        </View>
      )}
      
      <ImagePreviewModal visible={!!previewUri} uri={previewUri} onClose={() => setPreviewUri(null)} />
      
      <FlatList
        data={files}
        keyExtractor={item => item.name}
        renderItem={renderItem}
        ListEmptyComponent={<Text style={styles.emptyText}>当前文件夹为空</Text>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FDF6F9' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 15,
    paddingVertical: 15,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#F2E1E6'
  },
  headerLeft: { width: 50 },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 18, fontWeight: 'bold', color: '#4A4043' },
  headerRight: { width: 80, flexDirection: 'row', justifyContent: 'flex-end' },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 15,
    borderBottomWidth: 1,
    borderBottomColor: '#F2E1E6',
    backgroundColor: '#FFFFFF'
  },
  selectedRow: { backgroundColor: '#FDE2E8' },
  fileName: { fontSize: 16, color: '#4A4043' },
  fileMeta: { fontSize: 12, color: '#8A7E81', marginTop: 4 },
  emptyText: { textAlign: 'center', marginTop: 50, color: '#8A7E81' },
  batchBar: { flexDirection: 'row', padding: 10, backgroundColor: '#F2E1E6', justifyContent: 'flex-end' }
});
