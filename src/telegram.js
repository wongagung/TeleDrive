const fs = require('fs');
const path = require('path');
require('dotenv').config();
const db = require('./db');

const BOT_TOKEN = process.env.BOT_TOKEN;
const GROUP_ID = process.env.GROUP_ID;
const LOCAL_API_URL = process.env.LOCAL_API_URL || 'http://127.0.0.1:8081';
const BASE = `${LOCAL_API_URL}/bot${BOT_TOKEN}`;

if (!BOT_TOKEN || !GROUP_ID) console.warn('[telegram.js] BOT_TOKEN / GROUP_ID belum di-set di .env');

const CATEGORIES = {
  dokumen: { label: '📄 Dokumen' }, gambar: { label: '🖼️ Gambar' }, video: { label: '🎬 Video' },
  audio: { label: '🎵 Audio' }, arsip: { label: '🗜️ Arsip' }, lainnya: { label: '📦 Lainnya' },
};
const EXT_MAP = {
  pdf:'dokumen',doc:'dokumen',docx:'dokumen',xls:'dokumen',xlsx:'dokumen',ppt:'dokumen',pptx:'dokumen',txt:'dokumen',csv:'dokumen',odt:'dokumen',
  jpg:'gambar',jpeg:'gambar',png:'gambar',gif:'gambar',webp:'gambar',svg:'gambar',bmp:'gambar',heic:'gambar',
  mp4:'video',mkv:'video',mov:'video',avi:'video',webm:'video',flv:'video',
  mp3:'audio',wav:'audio',ogg:'audio',flac:'audio',m4a:'audio',aac:'audio',
  zip:'arsip',rar:'arsip','7z':'arsip',tar:'arsip',gz:'arsip',
};
function classifyCategory(originalName,mimeType){const ext=(path.extname(originalName||'').slice(1)||'').toLowerCase();if(EXT_MAP[ext])return EXT_MAP[ext];if(mimeType){if(mimeType.startsWith('image/'))return'gambar';if(mimeType.startsWith('video/'))return'video';if(mimeType.startsWith('audio/'))return'audio';if(mimeType==='application/pdf')return'dokumen';if(mimeType.includes('zip')||mimeType.includes('compressed'))return'arsip';}return'lainnya';}
async function getOrCreateTopic(category){const cached=db.prepare('SELECT thread_id FROM telegram_topics WHERE category = ?').get(category);if(cached)return cached.thread_id;const meta=CATEGORIES[category]||CATEGORIES.lainnya;const form=new URLSearchParams();form.append('chat_id',GROUP_ID);form.append('name',meta.label);const res=await fetch(`${BASE}/createForumTopic`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form});const data=await res.json();if(!data.ok)throw new Error(`Gagal buat Topic Telegram untuk kategori "${category}": ${data.description||JSON.stringify(data)}. Pastikan grup Forum/Topics aktif dan bot punya izin Manage Topics.`);const threadId=data.result?.message_thread_id;if(!threadId)throw new Error(`Telegram membuat topic tetapi message_thread_id tidak ada: ${JSON.stringify(data)}`);db.prepare('INSERT INTO telegram_topics (category, thread_id) VALUES (?, ?)').run(category,threadId);return threadId;}

/** Upload multipart ke Local Bot API dan selalu validasi struktur response sebelum membaca file_id. */
async function uploadChunk(localFilePath,displayName,threadId){
  const absPath=path.resolve(localFilePath);
  if(!fs.existsSync(absPath))throw new Error(`File chunk tidak ditemukan: ${absPath}`);
  const stat=fs.statSync(absPath);if(!stat.isFile()||stat.size<=0)throw new Error(`File chunk kosong/tidak valid: ${absPath}`);
  const blob=await fs.openAsBlob(absPath);
  const form=new FormData();form.append('chat_id',GROUP_ID);form.append('document',blob,displayName);form.append('caption',displayName);if(threadId)form.append('message_thread_id',String(threadId));
  let res,data;
  try{res=await fetch(`${BASE}/sendDocument`,{method:'POST',body:form});data=await res.json();}
  catch(err){throw new Error(`Koneksi ke Local Bot API gagal saat sendDocument: ${err.message}`);}
  if(!data||!data.ok){throw new Error(`Telegram sendDocument gagal (HTTP ${res?.status||'?' }): ${data?.description||JSON.stringify(data)}`);}
  const message=data.result;
  const media=message?.document||message?.video||message?.audio||message?.animation;
  const fileId=media?.file_id;
  if(!fileId){
    console.error('[telegram.js] Response sendDocument tanpa media file_id:',JSON.stringify(data));
    throw new Error(`Telegram menerima request tetapi response tidak berisi file_id. Response: ${JSON.stringify(data).slice(0,1200)}`);
  }
  return {file_id:fileId,file_size:Number(media.file_size)||stat.size,message_id:message.message_id};
}
async function getLocalFilePath(fileId){const res=await fetch(`${BASE}/getFile?file_id=${encodeURIComponent(fileId)}`);const data=await res.json();if(!data.ok)throw new Error(`Telegram getFile gagal: ${JSON.stringify(data)}`);const filePath=data.result?.file_path;if(!filePath)throw new Error(`Telegram getFile tidak mengembalikan file_path untuk file_id ${fileId}`);if(fs.existsSync(filePath))return filePath;const tmpDir=process.env.TMP_DIR||'./tmp';fs.mkdirSync(tmpDir,{recursive:true});const dest=path.join(tmpDir,`dl-${Date.now()}-${path.basename(filePath)}`);const dlRes=await fetch(`${LOCAL_API_URL}/file/bot${BOT_TOKEN}/${filePath}`);if(!dlRes.ok)throw new Error(`Download file Telegram gagal: HTTP ${dlRes.status}`);const buf=Buffer.from(await dlRes.arrayBuffer());fs.writeFileSync(dest,buf);return dest;}
async function deleteMessage(messageId){try{const form=new URLSearchParams();form.append('chat_id',GROUP_ID);form.append('message_id',messageId);const res=await fetch(`${BASE}/deleteMessage`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form});const data=await res.json();if(!data.ok)console.warn('[deleteMessage] gagal:',data.description);}catch(err){console.warn('[deleteMessage] error:',err.message);}}
module.exports={uploadChunk,getLocalFilePath,deleteMessage,classifyCategory,getOrCreateTopic,CATEGORIES};
