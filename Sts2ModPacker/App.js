import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, SafeAreaView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BindingProvider } from './utils/BindingContext';
import FileBrowserScreen from './screens/FileBrowserScreen';
import BindingScreen from './screens/BindingScreen';
import AboutScreen from './screens/AboutScreen';

export default function App() {
  const [activeTab, setActiveTab] = useState('browser');

  useEffect(() => {
    // Initial folder setup
    (async () => {
      const { ensureDir, rootDir } = require('./utils/fs');
      await ensureDir(rootDir + 'output');
      await ensureDir(rootDir + 'imports');
      await ensureDir(rootDir + 'root/tres');
    })();
  }, []);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#FDF6F9' }}>
      <BindingProvider>
        <AppContent activeTab={activeTab} setActiveTab={setActiveTab} />
      </BindingProvider>
    </SafeAreaView>
  );
}

function AppContent({ activeTab, setActiveTab }) {
  const { scanCards } = require('./utils/BindingContext').useBindings();

  useEffect(() => {
    scanCards();
  }, []);

  return (
    <>
        <View style={{ flex: 1 }}>
          {activeTab === 'browser' ? <FileBrowserScreen /> : 
           activeTab === 'bind' ? <BindingScreen /> : 
           <AboutScreen />}
        </View>

        {/* Custom Bottom Tab Bar */}
        <View style={styles.tabBar}>
          <TouchableOpacity 
            style={styles.tabItem} 
            onPress={() => setActiveTab('browser')}
          >
            <Ionicons name={activeTab === 'browser' ? 'folder' : 'folder-outline'} size={24} color={activeTab === 'browser' ? '#F4A8B6' : 'gray'} />
            <Text style={[styles.tabText, { color: activeTab === 'browser' ? '#F4A8B6' : 'gray' }]}>文件浏览</Text>
          </TouchableOpacity>
          <TouchableOpacity 
            style={styles.tabItem} 
            onPress={() => setActiveTab('bind')}
          >
            <Ionicons name={activeTab === 'bind' ? 'link' : 'link-outline'} size={24} color={activeTab === 'bind' ? '#F4A8B6' : 'gray'} />
            <Text style={[styles.tabText, { color: activeTab === 'bind' ? '#F4A8B6' : 'gray' }]}>关系绑定</Text>
          </TouchableOpacity>
          <TouchableOpacity 
            style={styles.tabItem} 
            onPress={() => setActiveTab('about')}
          >
            <Ionicons name={activeTab === 'about' ? 'information-circle' : 'information-circle-outline'} size={24} color={activeTab === 'about' ? '#F4A8B6' : 'gray'} />
            <Text style={[styles.tabText, { color: activeTab === 'about' ? '#F4A8B6' : 'gray' }]}>关于</Text>
          </TouchableOpacity>
        </View>
    </>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: '#E0E0E0',
    backgroundColor: '#FFFFFF',
    paddingBottom: 20, // rough safe area padding for bottom
    paddingTop: 10,
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabText: {
    fontSize: 12,
    marginTop: 4
  }
});
