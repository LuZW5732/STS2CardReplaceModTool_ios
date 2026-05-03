import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Modal, View, Text, StyleSheet, TouchableOpacity, TextInput, FlatList, Image, Dimensions, SafeAreaView, PanResponder, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system/legacy';
import { useBindings } from '../utils/BindingContext';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

export default function CropperModal({ visible, image, onClose, onSave }) {
  const { cardsData } = useBindings();
  const [search, setSearch] = useState('');
  const [selectedCard, setSelectedCard] = useState(null);
  
  const selectedCardRef = useRef(null);
  useEffect(() => { selectedCardRef.current = selectedCard; }, [selectedCard]);

  // Auto-match template when image loads
  useEffect(() => {
    if (visible && image?.name) {
      const baseName = image.name.replace(/\.[^/.]+$/, "").replace(/[_\-\d]/g, " ").trim().toLowerCase();
      if (baseName) {
        setSearch(baseName);
        
        // Exact match
        const exactMatch = cardsData.find(c => 
          c.name.toLowerCase() === baseName.replace(/\s+/g, '_') || 
          c.name.toLowerCase() === baseName
        );
        
        if (exactMatch) {
          setSelectedCard(exactMatch);
        } else {
          // Fuzzy match
          const fuzzyMatch = cardsData.find(c => 
            c.name.toLowerCase().includes(baseName) || 
            baseName.includes(c.name.toLowerCase()) ||
            baseName.includes(c.cat.toLowerCase())
          );
          if (fuzzyMatch) {
            setSelectedCard(fuzzyMatch);
          }
        }
      }
    } else if (!visible) {
      setSearch('');
      setSelectedCard(null);
    }
  }, [visible, image]);

  const filteredCards = useMemo(() => {
    if (!search) return [];
    return cardsData.filter(c => 
      c.name.toLowerCase().includes(search.toLowerCase()) || 
      c.cat.toLowerCase().includes(search.toLowerCase())
    ).slice(0, 10);
  }, [search]);

  // Built-in Animated values
  const pan = useRef(new Animated.ValueXY()).current;
  const scale = useRef(new Animated.Value(0)).current;
  
  // Decoupled slider position for perfect 1:1 finger tracking
  const sliderPos = useRef(new Animated.Value(0)).current;
  const lastSliderPos = useRef(0);
  
  const lastPan = useRef({ x: 0, y: 0 });
  const lastScale = useRef(0); // 0 = not initialized; will be set to minScale on first card load

  const previousTouchInfo = useRef({ length: 0, center: {x: 0, y: 0}, dist: 0 });
  const minScaleRef = useRef(0.1);
  const imageSizeRef = useRef({ w: 1000, h: 1000 });
  
  const trackWidth = 200;
  const maxScale = 3; // Reduced max scale
  
  // Calculate min scale based on image size and mask size
  React.useEffect(() => {
    if (selectedCard && image?.uri) {
      Image.getSize(image.uri, (w, h) => {
        let renderW, renderH;
        if (w > h) {
          renderW = 1000;
          renderH = 1000 * (h / w);
        } else {
          renderH = 1000;
          renderW = 1000 * (w / h);
        }
        imageSizeRef.current = { w: renderW, h: renderH };
        const maskW = selectedCard.w * 0.5;
        const maskH = selectedCard.h * 0.5;
        const calcMinScale = Math.max(maskW / renderW, maskH / renderH);
        minScaleRef.current = calcMinScale;
        
        if (lastScale.current === 0 || lastScale.current < calcMinScale) {
          // Initialize to minScale (image fills mask exactly) or fix if user scale became too small
          scale.setValue(calcMinScale);
          lastScale.current = calcMinScale;
          lastPan.current = { x: 0, y: 0 };
          pan.setValue({ x: 0, y: 0 });
          lastSliderPos.current = 0;
          sliderPos.setValue(0);
        } else {
          // Update slider to match current scale relative to new minScale
          let percent = (lastScale.current - calcMinScale) / (maxScale - calcMinScale);
          if (percent < 0) percent = 0;
          if (percent > 1) percent = 1;
          lastSliderPos.current = percent * trackWidth;
          sliderPos.setValue(percent * trackWidth);
        }
      }, () => {
        // Fallback if getSize fails
        minScaleRef.current = 0.1;
      });
    }
  }, [selectedCard, image]);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        previousTouchInfo.current = { length: 0 };
      },
      onPanResponderMove: (evt) => {
        const touches = evt.nativeEvent.touches;
        const applyPanWithBounds = (dx, dy) => {
          if (!selectedCardRef.current || !imageSizeRef.current) return;
          
          let newX = lastPan.current.x + dx;
          let newY = lastPan.current.y + dy;
          
          const currentScale = lastScale.current;
          const { w: renderW, h: renderH } = imageSizeRef.current;
          
          const maskW = selectedCardRef.current.w * 0.5;
          const maskH = selectedCardRef.current.h * 0.5;
          
          const maxX = Math.max(0, (renderW * currentScale - maskW) / 2);
          const maxY = Math.max(0, (renderH * currentScale - maskH) / 2);
          
          newX = Math.max(-maxX, Math.min(maxX, newX));
          newY = Math.max(-maxY, Math.min(maxY, newY));
          
          lastPan.current.x = newX;
          lastPan.current.y = newY;
          pan.setValue({ x: newX, y: newY });
        };

        if (touches.length === 1) {
          const t = touches[0];
          if (previousTouchInfo.current.length !== 1) {
            previousTouchInfo.current = { length: 1, x: t.pageX, y: t.pageY };
          } else {
            const dx = t.pageX - previousTouchInfo.current.x;
            const dy = t.pageY - previousTouchInfo.current.y;
            applyPanWithBounds(dx, dy);
            previousTouchInfo.current = { length: 1, x: t.pageX, y: t.pageY };
          }
        } else if (touches.length >= 2) {
          const t1 = touches[0];
          const t2 = touches[1];
          const center = { x: (t1.pageX + t2.pageX) / 2, y: (t1.pageY + t2.pageY) / 2 };
          const dist = Math.hypot(t1.pageX - t2.pageX, t1.pageY - t2.pageY);
          
          if (previousTouchInfo.current.length < 2) {
            previousTouchInfo.current = { length: 2, center, dist };
          } else {
            const dx = center.x - previousTouchInfo.current.center.x;
            const dy = center.y - previousTouchInfo.current.center.y;
            
            const scaleRatio = dist / previousTouchInfo.current.dist;
            let newScale = lastScale.current * scaleRatio;
            
            if (newScale < minScaleRef.current) {
                newScale = minScaleRef.current;
            }

            lastScale.current = newScale;
            scale.setValue(newScale);
            
            // Sync slider position back
            let percent = (newScale - minScaleRef.current) / (maxScale - minScaleRef.current);
            if (percent < 0) percent = 0;
            if (percent > 1) percent = 1;
            lastSliderPos.current = percent * trackWidth;
            sliderPos.setValue(percent * trackWidth);

            // Apply pan AFTER scale update so bounds reflect the new scale
            applyPanWithBounds(dx, dy);
            
            previousTouchInfo.current = { length: 2, center, dist };
          }
        }
      },
      onPanResponderRelease: () => {
        previousTouchInfo.current = { length: 0 };
      },
      onPanResponderTerminate: () => {
        previousTouchInfo.current = { length: 0 };
      }
    })
  ).current;

  // Horizontal Zoom Slider logic
  const sliderStartPos = useRef(0);

  const applyPanWithBoundsStandalone = (dx, dy) => {
    if (!selectedCardRef.current || !imageSizeRef.current) return;
    
    let newX = lastPan.current.x + dx;
    let newY = lastPan.current.y + dy;
    
    const currentScale = lastScale.current;
    const { w: renderW, h: renderH } = imageSizeRef.current;
    
    const maskW = selectedCardRef.current.w * 0.5;
    const maskH = selectedCardRef.current.h * 0.5;
    
    const maxX = Math.max(0, (renderW * currentScale - maskW) / 2);
    const maxY = Math.max(0, (renderH * currentScale - maskH) / 2);
    
    newX = Math.max(-maxX, Math.min(maxX, newX));
    newY = Math.max(-maxY, Math.min(maxY, newY));
    
    lastPan.current.x = newX;
    lastPan.current.y = newY;
    pan.setValue({ x: newX, y: newY });
  };

  const horizontalSliderPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onStartShouldSetPanResponderCapture: () => true,
      onMoveShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponderCapture: () => true,
      onPanResponderGrant: () => {
        sliderStartPos.current = lastSliderPos.current;
      },
      onPanResponderMove: (evt, gestureState) => {
        // 1:1 perfect finger tracking
        let newPos = sliderStartPos.current + gestureState.dx;
        
        if (newPos < 0) newPos = 0;
        if (newPos > trackWidth) newPos = trackWidth;
        
        lastSliderPos.current = newPos;
        sliderPos.setValue(newPos);
        
        // Map pos back to scale exactly
        const currentMin = minScaleRef.current;
        const percent = newPos / trackWidth;
        const newScale = currentMin + percent * (maxScale - currentMin);
        
        lastScale.current = newScale;
        scale.setValue(newScale);
        
        applyPanWithBoundsStandalone(0, 0);
      }
    })
  ).current;

  const stepZoom = (direction) => {
    let newPos = lastSliderPos.current + direction * 20; // jump 20 pixels
    if (newPos < 0) newPos = 0;
    if (newPos > trackWidth) newPos = trackWidth;
    
    lastSliderPos.current = newPos;
    sliderPos.setValue(newPos);
    
    const currentMin = minScaleRef.current;
    const percent = newPos / trackWidth;
    const newScale = currentMin + percent * (maxScale - currentMin);
    
    lastScale.current = newScale;
    scale.setValue(newScale);
    
    applyPanWithBoundsStandalone(0, 0);
  };

  const handleSave = () => {
    if (!selectedCard) {
      alert("请先搜索并选择一个卡牌模版");
      return;
    }
    
    onSave({
      cardId: selectedCard.id,
      cardName: selectedCard.name,
      cardCat: selectedCard.cat,
      isBeta: selectedCard.is_beta || false,
      atlas: selectedCard.atlas,
      rect: { x: selectedCard.x, y: selectedCard.y, w: selectedCard.w, h: selectedCard.h },
      transform: { x: lastPan.current.x, y: lastPan.current.y, scale: lastScale.current }
    });
  };

  return (
    <Modal visible={visible} animationType="slide">
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose}><Text style={styles.cancelText}>取消</Text></TouchableOpacity>
          <Text style={styles.title}>编辑与绑定</Text>
          <TouchableOpacity onPress={handleSave}><Text style={styles.saveText}>保存</Text></TouchableOpacity>
        </View>

        {/* Search Section */}
        <View style={styles.searchSection}>
          <TextInput 
            style={styles.searchInput}
            placeholder="搜索卡牌名称或分类..."
            value={search}
            onChangeText={setSearch}
            placeholderTextColor="#8A7E81"
          />
          {filteredCards.length > 0 && (
            <FlatList
              data={filteredCards}
              keyExtractor={item => item.id}
              style={styles.searchList}
              renderItem={({ item }) => (
                <TouchableOpacity style={styles.searchItem} onPress={() => {
                    setSelectedCard(item);
                    setSearch('');
                }}>
                  <Text style={styles.searchItemText}>{item.name}{item.is_beta ? ' (Beta)' : ''} ({item.cat})</Text>
                </TouchableOpacity>
              )}
            />
          )}
        </View>

        {/* Card Template Info */}
        {selectedCard ? (
          <View style={styles.cardInfoBar}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Ionicons name="card" size={20} color="#F4A8B6" />
              <Text style={styles.cardInfoText}>目标: {selectedCard.name}{selectedCard.is_beta ? ' (Beta)' : ''} | 尺寸: {selectedCard.w}x{selectedCard.h}</Text>
            </View>
            {/* Sprite-sheet Template Preview */}
            <View style={{ width: 40, height: 40, overflow: 'hidden', borderWidth: 1, borderColor: '#F4A8B6', marginLeft: 10 }}>
              <Image 
                source={{ uri: FileSystem.documentDirectory + 'root/' + selectedCard.atlas }}
                style={{ 
                  width: selectedCard.atlas === 'card_atlas_2.png' ? 2268 * (40 / selectedCard.w) : 4032 * (40 / selectedCard.w), 
                  height: selectedCard.atlas === 'card_atlas_1.png' ? 4028 * (40 / selectedCard.w) : (selectedCard.atlas === 'card_atlas_0.png' ? 4080 * (40 / selectedCard.w) : 4032 * (40 / selectedCard.w)),
                  position: 'absolute',
                  left: -selectedCard.x * (40 / selectedCard.w),
                  top: -selectedCard.y * (40 / selectedCard.w),
                }} 
              />
            </View>
          </View>
        ) : (
          <View style={styles.cardInfoBar}><Text style={styles.promptText}>请先搜索卡牌模版以确定裁剪尺寸</Text></View>
        )}

        {/* Cropper Area */}
        <View style={styles.cropContainer} {...panResponder.panHandlers}>
          <Animated.View style={[
            styles.imageWrapper, 
            { transform: [{ translateX: pan.x }, { translateY: pan.y }, { scale: scale }] }
          ]}>
            <Image source={{ uri: image.uri }} style={styles.image} />
          </Animated.View>

          {/* Mask Overlay */}
          {selectedCard && (
            <View style={styles.maskOverlay} pointerEvents="none">
              <View style={[styles.maskHole, { width: selectedCard.w * 0.5, height: selectedCard.h * 0.5 }]} />
            </View>
          )}
        </View>

        <View style={styles.footer}>
          {/* Horizontal Zoom Slider */}
          <View style={styles.horizontalSliderContainer}>
            <TouchableOpacity onPress={() => stepZoom(-1)} style={{ padding: 10 }}>
              <Ionicons name="remove" size={24} color="#C0CAF5" />
            </TouchableOpacity>
            <View style={styles.horizontalSliderTrack} {...horizontalSliderPanResponder.panHandlers}>
              <Animated.View style={[styles.horizontalSliderKnob, { transform: [{ translateX: sliderPos }] }]} />
            </View>
            <TouchableOpacity onPress={() => stepZoom(1)} style={{ padding: 10 }}>
              <Ionicons name="add" size={24} color="#C0CAF5" />
            </TouchableOpacity>
          </View>

          <Text style={styles.footerHint}>提示：双指缩放，单指拖动图片对准方框</Text>
          <Text style={styles.footerImageName}>当前图片: {image?.name}</Text>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1A1B26' },
  header: { 
    flexDirection: 'row', 
    justifyContent: 'space-between', 
    padding: 20, 
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#333'
  },
  cancelText: { color: '#8A7E81', fontSize: 16 },
  title: { color: '#FFF', fontSize: 18, fontWeight: 'bold' },
  saveText: { color: '#A3D9A5', fontSize: 16, fontWeight: 'bold' },
  searchSection: { padding: 15, zIndex: 10 },
  searchInput: { backgroundColor: '#24283B', color: '#FFF', padding: 12, borderRadius: 10, fontSize: 16 },
  searchList: { backgroundColor: '#24283B', borderRadius: 10, marginTop: 5, maxHeight: 200 },
  searchItem: { padding: 15, borderBottomWidth: 1, borderBottomColor: '#1A1B26' },
  searchItemText: { color: '#C0CAF5' },
  cardInfoBar: { flexDirection: 'row', padding: 15, backgroundColor: '#24283B', alignItems: 'center' },
  cardInfoText: { color: '#F4A8B6', marginLeft: 10, fontWeight: 'bold' },
  promptText: { color: '#8A7E81', fontStyle: 'italic' },
  cropContainer: { flex: 1, overflow: 'hidden', justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' },
  imageWrapper: { width: 1000, height: 1000, justifyContent: 'center', alignItems: 'center' },
  image: { width: '100%', height: '100%', resizeMode: 'contain' },
  maskOverlay: { ...StyleSheet.absoluteFillObject, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.5)' },
  maskHole: { borderWidth: 2, borderColor: '#F4A8B6', backgroundColor: 'transparent' },
  footer: { padding: 20, alignItems: 'center' },
  footerHint: { color: '#8A7E81', fontSize: 12 },
  footerImageName: { color: '#F4A8B6', marginTop: 10, fontSize: 14, fontWeight: 'bold' },
  horizontalSliderContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    justifyContent: 'center',
    marginBottom: 15,
    paddingVertical: 10,
  },
  horizontalSliderTrack: {
    width: 200,
    height: 6,
    backgroundColor: '#8A7E81',
    borderRadius: 3,
    marginHorizontal: 15,
    justifyContent: 'center'
  },
  horizontalSliderKnob: {
    position: 'absolute',
    left: -12,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#F4A8B6',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.5,
    shadowRadius: 3,
    elevation: 5
  }
});
