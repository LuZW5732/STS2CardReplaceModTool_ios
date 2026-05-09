import React from 'react';
import { View, Text, StyleSheet, Image, Linking, TouchableOpacity, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

export default function AboutScreen() {
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>关于</Text>
      </View>
      
      <ScrollView contentContainerStyle={styles.content}>
        <Image 
          source={require('../assets/FF165F5FE46A50416D9E9A69B85AF1D0(1).png')} 
          style={{ width: 120, height: 120, borderRadius: 25, marginTop: 20, marginBottom: 15 }} 
        />
        
        <Text style={styles.appName}>CardPacker</Text>
        <Text style={styles.version}>V3.0</Text>
        
        <View style={styles.card}>
          <View style={styles.row}>
            <Ionicons name="person" size={20} color="#8A7E81" />
            <Text style={styles.label}>作者：</Text>
            <Text style={styles.value}>樱大路露娜</Text>
          </View>

          <TouchableOpacity style={styles.row} onPress={() => Linking.openURL('mailto:sakurakoji_luna1@foxmail.com')}>
            <Ionicons name="mail" size={20} color="#8A7E81" />
            <Text style={styles.label}>邮箱：</Text>
            <Text style={styles.value}>sakurakoji_luna1@foxmail.com</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.row} onPress={() => {}}>
            <Ionicons name="chatbubbles" size={20} color="#8A7E81" />
            <Text style={styles.label}>QQ群：</Text>
            <Text style={styles.value}>761405177 (iOS杀戮尖塔2)</Text>
          </TouchableOpacity>

          <TouchableOpacity style={[styles.row, { borderBottomWidth: 0 }]} onPress={() => {}}>
            <Ionicons name="chatbox-ellipses" size={20} color="#8A7E81" />
            <Text style={styles.label}>QQ频道：</Text>
            <Text style={styles.value}>pd12081764</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.noticeCard}>
          <Ionicons name="warning" size={32} color="#D97706" style={{marginBottom: 10}} />
          <Text style={styles.noticeTitle}>免责声明</Text>
          <Text style={styles.noticeText}>
            该软件仅用于iOS版杀戮尖塔2学习交流，请勿转载或商业使用。
          </Text>
          <Text style={[styles.noticeText, { marginTop: 10 }]}>
            该软件是用于制作可替换iOS端卡图的mod的工具软件。
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FDF6F9' },
  header: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 15,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#F2E1E6'
  },
  headerTitle: { fontSize: 18, fontWeight: 'bold', color: '#4A4043', textAlign: 'center', flex: 1 },
  content: { alignItems: 'center', padding: 20 },
  logo: { marginTop: 20, marginBottom: 10 },
  appName: { fontSize: 24, fontWeight: 'bold', color: '#4A4043' },
  version: { fontSize: 16, color: '#8A7E81', marginBottom: 30 },
  card: {
    width: '100%',
    backgroundColor: '#FFF',
    borderRadius: 15,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 5,
    elevation: 3,
    marginBottom: 25
  },
  row: { 
    flexDirection: 'row', 
    alignItems: 'center', 
    paddingVertical: 15, 
    borderBottomWidth: 1, 
    borderBottomColor: '#FDF6F9' 
  },
  label: { fontSize: 16, color: '#8A7E81', marginLeft: 10, width: 80 },
  value: { fontSize: 16, color: '#4A4043', flex: 1, textAlign: 'right', fontWeight: '500' },
  noticeCard: {
    width: '100%',
    backgroundColor: '#FEF3C7',
    borderRadius: 15,
    padding: 20,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#FDE68A'
  },
  noticeTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#D97706',
    marginBottom: 10
  },
  noticeText: { 
    fontSize: 14, 
    color: '#92400E', 
    textAlign: 'center', 
    lineHeight: 22 
  }
});
