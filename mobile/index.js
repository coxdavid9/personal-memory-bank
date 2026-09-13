import React, {useEffect, useState} from 'react';
import {SafeAreaView, View, Text, TextInput, Pressable, FlatList, StyleSheet, ActivityIndicator} from 'react-native';
import {StatusBar} from 'expo-status-bar';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'https://personal-memory-bank.onrender.com';

export default function App() {
  const [messages, setMessages] = useState([]);
  const [message, setMessage] = useState('');
  const [caps, setCaps] = useState([]);
  const [projects, setProjects] = useState([]);
  const [busy, setBusy] = useState(false);

  async function api(path, options={}) {
    const response = await fetch(`${API_URL}${path}`, {headers:{'Content-Type':'application/json', ...(options.headers || {})}, ...options});
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  useEffect(() => {
    (async () => {
      try {
        const [history, context] = await Promise.all([api('/api/agent/messages'), api('/api/agent/context')]);
        setMessages(history.messages || []);
        setCaps(context.capabilities || []);
        setProjects(context.projects || []);
      } catch (_) {}
    })();
  }, []);

  async function send(textOverride) {
    const text = (textOverride ?? message).trim();
    if (!text || busy) return;
    setMessage('');
    setMessages(prev => [...prev, {role:'user', content:text}]);
    setBusy(true);
    try {
      const data = await api('/api/agent/chat', {method:'POST', body:JSON.stringify({message:text})});
      setMessages(prev => [...prev, {role:'assistant', content:data.reply}]);
    } catch (error) {
      setMessages(prev => [...prev, {role:'assistant', content:`I hit an error: ${error.message}`}]);
    } finally { setBusy(false); }
  }

  return <SafeAreaView style={styles.safe}>
    <StatusBar style="dark" />
    <View style={styles.header}><View style={styles.orb}><Text style={styles.orbText}>🧠</Text></View><View><Text style={styles.title}>David's Personal Agent</Text><Text style={styles.subtitle}>Knows what matters. Helps move it forward.</Text></View></View>
    <FlatList
      style={styles.list}
      contentContainerStyle={styles.content}
      data={messages}
      keyExtractor={(item, index) => `${index}-${item.role}`}
      ListHeaderComponent={<View><Text style={styles.sectionTitle}>Talk to your agent</Text><Text style={styles.muted}>Your agent is being built around memory, projects, and expandable capabilities.</Text><View style={styles.quickRow}><Quick text="What should I work on?" onPress={() => send('What should I be working on right now?')} /><Quick text="ClearCFO" onPress={() => send('What do you know about ClearCFO?')} /><Quick text="Job search" onPress={() => send('What do you know about my job search?')} /></View></View>}
      renderItem={({item}) => <View style={[styles.bubble, item.role === 'user' ? styles.user : styles.assistant]}><Text style={item.role === 'user' ? styles.userText : styles.assistantText}>{item.content}</Text></View>}
      ListFooterComponent={<View><Text style={styles.sectionTitle}>Capabilities</Text>{caps.map(c => <View style={styles.card} key={c.key}><Text style={styles.cardTitle}>{c.name}</Text><Text style={styles.muted}>{c.description}</Text></View>)}<Text style={styles.sectionTitle}>Projects</Text>{projects.map(p => <View style={styles.card} key={p.name}><Text style={styles.cardTitle}>{p.name}</Text><Text style={styles.muted}>{p.description}</Text></View>)}</View>}
    />
    <View style={styles.composer}><TextInput value={message} onChangeText={setMessage} placeholder="Tell me what you're thinking..." placeholderTextColor="#98A2B3" style={styles.input} multiline /><Pressable style={styles.send} onPress={() => send()} disabled={busy}>{busy ? <ActivityIndicator color="#fff"/> : <Text style={styles.sendText}>Send</Text>}</Pressable></View>
  </SafeAreaView>;
}

function Quick({text,onPress}) { return <Pressable style={styles.quick} onPress={onPress}><Text style={styles.quickText}>{text}</Text></Pressable>; }

const styles = StyleSheet.create({safe:{flex:1,backgroundColor:'#F5F7FB'},header:{flexDirection:'row',alignItems:'center',paddingHorizontal:18,paddingTop:8,paddingBottom:12,gap:12},orb:{width:45,height:45,borderRadius:14,backgroundColor:'#172033',alignItems:'center',justifyContent:'center'},orbText:{fontSize:22},title:{fontSize:20,fontWeight:'800',color:'#172033'},subtitle:{fontSize:12,color:'#667085',marginTop:2},list:{flex:1},content:{paddingHorizontal:16,paddingBottom:14},sectionTitle:{fontSize:17,fontWeight:'800',color:'#172033',marginTop:10,marginBottom:5},muted:{fontSize:13,color:'#667085',lineHeight:18},quickRow:{flexDirection:'row',flexWrap:'wrap',gap:7,marginVertical:12},quick:{backgroundColor:'#EEF2F6',paddingHorizontal:10,paddingVertical:8,borderRadius:10},quickText:{fontSize:12,fontWeight:'700',color:'#172033'},bubble:{maxWidth:'88%',padding:12,borderRadius:15,marginVertical:5},user:{alignSelf:'flex-end',backgroundColor:'#172033',borderBottomRightRadius:5},assistant:{alignSelf:'flex-start',backgroundColor:'#fff',borderWidth:1,borderColor:'#E4E7EC',borderBottomLeftRadius:5},userText:{color:'#fff',fontSize:15,lineHeight:21},assistantText:{color:'#172033',fontSize:15,lineHeight:21},card:{backgroundColor:'#fff',borderWidth:1,borderColor:'#E4E7EC',borderRadius:12,padding:12,marginVertical:5},cardTitle:{fontWeight:'800',fontSize:14,color:'#172033',marginBottom:3},composer:{flexDirection:'row',alignItems:'flex-end',gap:8,padding:10,borderTopWidth:1,borderTopColor:'#E4E7EC',backgroundColor:'#fff'},input:{flex:1,maxHeight:100,minHeight:44,borderWidth:1,borderColor:'#D0D5DD',borderRadius:12,paddingHorizontal:12,paddingVertical:10,fontSize:15,color:'#172033',backgroundColor:'#fff'},send:{backgroundColor:'#172033',minWidth:62,height:44,borderRadius:12,alignItems:'center',justifyContent:'center'},sendText:{color:'#fff',fontWeight:'800'}});
