requireLogin();
const whoami=document.getElementById('whoami');
const logoutBtn=document.getElementById('logoutBtn');
const refreshBtn=document.getElementById('refreshBtn');
const statsRow=document.getElementById('statsRow');
const userBody=document.getElementById('userBody');
const userCount=document.getElementById('userCount');
const toast=document.getElementById('adminToast');
const quotaModal=document.getElementById('quotaModal');
const quotaInput=document.getElementById('quotaInput');
const quotaUserLabel=document.getElementById('quotaUserLabel');
const quotaSaveBtn=document.getElementById('quotaSaveBtn');
let quotaTarget=null;
whoami.textContent=localStorage.getItem('td_username')||'';
logoutBtn.onclick=logout;
refreshBtn.onclick=()=>init(true);

document.querySelectorAll('[data-close-modal]').forEach(el=>el.onclick=closeQuotaModal);
quotaModal.addEventListener('click',e=>{if(e.target===quotaModal)closeQuotaModal();});
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeQuotaModal();});
function fmtSize(bytes){bytes=Number(bytes)||0;if(bytes<1024)return bytes+' B';const units=['KB','MB','GB','TB'];let i=-1;do{bytes/=1024;i++;}while(bytes>=1024&&i<units.length-1);return bytes.toFixed(bytes>=100?0:1)+' '+units[i];}
function escapeHtml(str){return String(str??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function toastMsg(msg,error=false){toast.textContent=msg;toast.classList.toggle('error',error);toast.hidden=false;clearTimeout(toast._t);toast._t=setTimeout(()=>toast.hidden=true,3200);}
function closeQuotaModal(){quotaModal.hidden=true;quotaTarget=null;}
function openQuotaModal(u){quotaTarget=u;quotaUserLabel.textContent=`Kuota untuk “${u.username}”`;quotaInput.value=u.has_custom_quota?Math.round(u.quota_bytes/1024/1024):0;quotaModal.hidden=false;setTimeout(()=>{quotaInput.focus();quotaInput.select();},30);}
quotaSaveBtn.onclick=async()=>{if(!quotaTarget)return;const mb=parseInt(quotaInput.value,10);if(!Number.isInteger(mb)||mb<0){toastMsg('Kuota harus berupa angka 0 atau lebih.',true);return;}quotaSaveBtn.disabled=true;try{const res=await api(`/api/admin/users/${quotaTarget.id}/quota`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({quota_mb:mb})});const data=await res.json().catch(()=>({}));if(!res.ok)throw new Error(data.error||'Gagal mengubah kuota');closeQuotaModal();toastMsg('Kuota berhasil diperbarui.');await loadUsers();}catch(e){toastMsg(e.message,true);}finally{quotaSaveBtn.disabled=false;}};
async function init(silent=false){try{const meRes=await api('/api/auth/me');if(!meRes)return;const me=await meRes.json();if(!me.is_admin){alert('Halaman ini khusus admin.');location.href='/index.html';return;}if(!silent)renderLoading();await Promise.all([loadStats(),loadUsers()]);}catch(e){toastMsg(e.message||'Gagal memuat panel admin.',true);}}
function renderLoading(){statsRow.innerHTML='<div class="stat-card"><div class="stat-label">Memuat statistik…</div></div>'.repeat(3);userBody.innerHTML='<tr><td colspan="5" class="loading-row">Memuat data pengguna…</td></tr>';}
async function loadStats(){const res=await api('/api/admin/stats');if(!res||!res.ok)return;const s=await res.json();statsRow.innerHTML=`<div class="stat-card"><div class="stat-value">${s.totalUsers}</div><div class="stat-label">Total User</div></div><div class="stat-card"><div class="stat-value">${s.totalFiles}</div><div class="stat-label">Total File</div></div><div class="stat-card"><div class="stat-value">${fmtSize(s.totalUsedBytes)}</div><div class="stat-label">Storage Terpakai</div></div>`;}
async function loadUsers(){const res=await api('/api/admin/users');if(!res){return;}const data=await res.json().catch(()=>({}));if(!res.ok){toastMsg(data.error||'Gagal mengambil user.',true);return;}const users=data.users||[];userCount.textContent=`${users.length} pengguna`;userBody.innerHTML='';if(!users.length){userBody.innerHTML='<tr><td colspan="5" class="empty-admin">Belum ada pengguna.</td></tr>';return;}
users.forEach(u=>{const pct=u.quota_bytes>0?Math.min(100,(u.used_bytes/u.quota_bytes)*100):0;const level=pct>=90?'danger':pct>=75?'warn':'';const tr=document.createElement('tr');tr.innerHTML=`<td><div class="admin-user"><div class="avatar">${escapeHtml((u.username||'?')[0].toUpperCase())}</div><div><div class="user-name">${escapeHtml(u.username)}</div><div class="user-role">${u.is_admin?'Administrator':'User'}</div></div></div></td><td>${new Date(u.created_at).toLocaleDateString('id-ID',{day:'2-digit',month:'short',year:'numeric'})}</td><td><div class="admin-storage"><div class="storage-line"><strong>${fmtSize(u.used_bytes)}</strong><span>${fmtSize(u.quota_bytes)}</span></div><div class="mini-bar"><div class="mini-bar-fill ${level}" style="width:${pct.toFixed(1)}%;background:#2b6cee"></div></div></div></td><td><span class="status-pill ${u.is_admin?'':'user'}">${u.is_admin?'● Admin':'● User'}</span></td><td><div class="row-actions"><button data-quota title="Ubah kuota">📊</button><button data-toggle-admin>${u.is_admin?'⬇ Demote':'⬆ Promote'}</button><button data-delete class="danger-btn">🗑</button></div></td>`;
tr.querySelector('[data-quota]').onclick=()=>openQuotaModal(u);
tr.querySelector('[data-toggle-admin]').onclick=async()=>{const makeAdmin=!u.is_admin;if(!confirm(`${makeAdmin?'Jadikan':'Cabut status admin dari'} “${u.username}”?`))return;const r=await api(`/api/admin/users/${u.id}/admin`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({is_admin:makeAdmin})});const d=await r.json().catch(()=>({}));if(!r.ok){toastMsg(d.error||'Operasi gagal.',true);return;}toastMsg(makeAdmin?'User dijadikan admin.':'Status admin dicabut.');await loadUsers();};
tr.querySelector('[data-delete]').onclick=async()=>{if(!confirm(`Hapus user “${u.username}” beserta semua metadata file & foldernya?\n\nFile yang sudah ada di Telegram tidak ikut terhapus.`))return;const r=await api(`/api/admin/users/${u.id}`,{method:'DELETE'});const d=await r.json().catch(()=>({}));if(!r.ok){toastMsg(d.error||'Gagal menghapus user.',true);return;}toastMsg('User berhasil dihapus.');await Promise.all([loadUsers(),loadStats()]);};userBody.appendChild(tr);});}
init();
