"use strict";
const {app, BrowserWindow, protocol, Menu, ipcMain, dialog, shell, net} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const {Readable} = require('node:stream');
const {pipeline} = require('node:stream/promises');
const {pathToFileURL} = require('node:url');

// Keep the same application identity and origin as v2.8 for existing data.
app.setAppUserModelId('com.mdfcutstudio.desktop');
protocol.registerSchemesAsPrivileged([{scheme:'mdfcut', privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true}}]);
const KEYS = Object.freeze({orders:'mdf-cut-studio-work-orders-v1',project:'mdf-cut-studio-v04'});
const MAX_SIZE = 80 * 1024 * 1024;
let backupDir;
const safeFile = kind => kind === 'orders' ? 'ordens.json' : 'projeto.json';
function ensureDir(){fs.mkdirSync(backupDir,{recursive:true});}
function checkPayload(kind, raw) {
  if (!Object.hasOwn(KEYS,kind) || typeof raw !== 'string' || Buffer.byteLength(raw,'utf8') > MAX_SIZE) throw Error('Dados inválidos ou muito grandes.');
  let obj;try{obj=JSON.parse(raw)}catch{throw Error('JSON inválido')}
  if (!obj || typeof obj!=='object')throw Error('Conteúdo inválido');
  if(kind==='orders' && (obj.version!==1 || !Array.isArray(obj.clients) || !Array.isArray(obj.orders)))throw Error('Backup de ordens inválido');
  if(kind==='project' && (obj.version!==3 || !Array.isArray(obj.parts) || !obj.settings))throw Error('Projeto inválido');
  return obj;
}
function atomicWrite(filename, content){
  ensureDir();const temp=filename+'.tmp-'+process.pid;
  fs.writeFileSync(temp,content,{encoding:'utf8',flag:'w'});
  try{fs.renameSync(temp,filename)}catch(e){try{fs.rmSync(temp,{force:true})}catch{}throw e}
}
function storeData(kind, raw){
  checkPayload(kind,raw);ensureDir();
  const current=path.join(backupDir,safeFile(kind));
  // Daily historical copies, captured before overwriting the current version.
  if(fs.existsSync(current)) {
    const date=new Date().toISOString().slice(0,10);
    const history=path.join(backupDir,`${kind}-${date}.json`);
    if(!fs.existsSync(history))fs.copyFileSync(current,history,fs.constants.COPYFILE_EXCL);
  }
  atomicWrite(current,raw);
  return {ok:true};
}
function requireTrusted(event){if(event.senderFrame?.url !== 'mdfcut://app/index.html')throw Error('Origem não autorizada')}

// Public GitHub Releases updater. Repo is configured by the user; never runs arbitrary commands.
const REPO_PATTERN=/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
let releasesRepo=null;
let latestCache=null;
function updaterConfigFile(){return path.join(app.getPath('userData'),'update-source.json')}
function loadUpdateSource(){
 try{const config=JSON.parse(fs.readFileSync(updaterConfigFile(),'utf8'));return REPO_PATTERN.test(config.repo)?config.repo:null}catch{return null}
}
function setUpdateSource(repo){
 repo=String(repo||'').trim().replace(/^https:\/\/github\.com\//i,'').replace(/\/$/,'').replace(/\.git$/,'');
 if(!REPO_PATTERN.test(repo)||repo.includes('..'))throw Error('Informe usuario/repositorio ou https://github.com/usuario/repositorio');
 atomicWrite(updaterConfigFile(),JSON.stringify({repo},null,2));releasesRepo=repo;latestCache=null;return {repo};
}
async function fetchRelease(){
 const repo=releasesRepo||loadUpdateSource();if(!repo)throw Error('Configure primeiro o repositório GitHub.');
 const response=await net.fetch(`https://api.github.com/repos/${repo}/releases/latest`,{headers:{'Accept':'application/vnd.github+json','User-Agent':'MDF-Cut-Studio-updater'}});
 if(!response.ok)throw Error(response.status===404?'Nenhuma versão pública publicada ainda (ou repositório não encontrado).':`GitHub respondeu HTTP ${response.status}`);
 const data=await response.json();const tag=String(data.tag_name||'');
 const version=tag.replace(/^v/i,'');if(!/^\d+\.\d+\.\d+$/.test(version))throw Error('Versão publicada inválida.');
 const exe=data.assets?.find(a=>/^MDF-Cut-Studio-\d+\.\d+\.\d+-Portable\.exe$/i.test(a.name) && a.name.includes(version));
 const sums=data.assets?.find(a=>a.name==='SHA256SUMS.txt');
 if(!exe||!sums)throw Error('A versão não contém o EXE portátil e o arquivo de verificação SHA256SUMS.txt.');
 latestCache={repo,version,tag,exe:{name:exe.name,url:exe.browser_download_url,size:exe.size},checksum:{url:sums.browser_download_url}};
 const installed=app.getVersion();const isNew=compareVersions(version,installed)>0;
 return {repo,installed,available:version,isNew,url:data.html_url,asset:exe.name};
}
function compareVersions(a,b){const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]>y[i]?1:-1;return 0}
function assertReleaseURL(url){const u=new URL(url);if(u.protocol!=='https:'||u.hostname!=='github.com'||!u.pathname.startsWith(`/${latestCache.repo}/releases/download/`))throw Error('Endereço de download não autorizado.');return url}
async function downloadNewVersion(){
 // Recheck release before download to avoid trusting stale UI state.
 const status=await fetchRelease();if(!status.isNew)throw Error('Você já está na versão mais recente.');
 const checksumUrl=assertReleaseURL(latestCache.checksum.url),exeUrl=assertReleaseURL(latestCache.exe.url);
 const r=await net.fetch(checksumUrl);if(!r.ok)throw Error('Não foi possível obter o checksum do GitHub.');
 const hashes=await r.text();const file=latestCache.exe.name;
 const line=hashes.split(/\r?\n/).find(l=>l.trim().endsWith('  '+file));
 if(!line||!/^([0-9a-f]{64})\s{2}/i.test(line))throw Error('Checksum SHA256 não encontrado para este executável.');
 const expected=line.match(/^([0-9a-f]{64})/i)[1].toLowerCase();
 const dir=app.getPath('downloads');const dest=path.join(dir,file),tmp=dest+'.download';
 const result=await net.fetch(exeUrl);if(!result.ok||!result.body)throw Error('Falha ao baixar atualização.');
 if(latestCache.exe.size>400*1024*1024)throw Error('Arquivo maior que o limite permitido.');
 const hasher=crypto.createHash('sha256');let count=0;
 try{
  const stream=Readable.fromWeb(result.body);
  stream.on('data',chunk=>{count+=chunk.length;hasher.update(chunk);if(count>400*1024*1024)stream.destroy(Error('Download excede o limite.'))});
  await pipeline(stream,fs.createWriteStream(tmp));
  if(hasher.digest('hex')!==expected)throw Error('Verificação SHA256 falhou; arquivo descartado.');
  fs.renameSync(tmp,dest);
 }catch(e){try{fs.rmSync(tmp,{force:true})}catch{}throw e}
 shell.showItemInFolder(dest);
 return {ok:true,file:dest,message:'Executável verificado e salvo na pasta Downloads. Feche o MDF Cut e abra o novo EXE.'};
}

function registerIPC(){
 ipcMain.handle('mdf:update-source',event=>{requireTrusted(event);return {repo:releasesRepo||loadUpdateSource()||'',version:app.getVersion()}});
 ipcMain.handle('mdf:set-update-source',(event,repo)=>{requireTrusted(event);return setUpdateSource(repo)});
 ipcMain.handle('mdf:check-update',async event=>{requireTrusted(event);return await fetchRelease()});
 ipcMain.handle('mdf:download-update',async event=>{requireTrusted(event);return await downloadNewVersion()});
 ipcMain.handle('mdf:save', (event,kind,raw)=>{requireTrusted(event);return storeData(kind,raw)});
 ipcMain.handle('mdf:status',event=>{requireTrusted(event);return {folder:backupDir,orders:fs.existsSync(path.join(backupDir,safeFile('orders'))),project:fs.existsSync(path.join(backupDir,safeFile('project')))}});
 ipcMain.handle('mdf:manual-backup',async event=>{
   requireTrusted(event);ensureDir();
   const output={application:'MDF Cut Studio - Backup Windows',version:1,createdAt:new Date().toISOString(),data:{}};
   for(const kind of Object.keys(KEYS)){
     const file=path.join(backupDir,safeFile(kind));
     if(fs.existsSync(file)){const raw=fs.readFileSync(file,'utf8');output.data[kind]=checkPayload(kind,raw)}
   }
   if(!Object.keys(output.data).length)throw Error('Ainda não há dados para salvar.');
   const {canceled,filePath}=await dialog.showSaveDialog({title:'Salvar backup completo',defaultPath:`MDF-Cut-Backup-${new Date().toISOString().slice(0,10)}.json`,filters:[{name:'Backup JSON',extensions:['json']}]});
   if(canceled||!filePath)return {canceled:true};
   // External copy; don't overwrite internal snapshots.
   fs.writeFileSync(filePath,JSON.stringify(output,null,2),'utf8');return {ok:true};
 });
 ipcMain.handle('mdf:restore-select',async event=>{
   requireTrusted(event);
   const {canceled,filePaths}=await dialog.showOpenDialog({title:'Selecionar backup MDF Cut',properties:['openFile'],filters:[{name:'Backup MDF Cut',extensions:['json']}]});
   if(canceled||!filePaths[0])return {canceled:true};
   const stat=fs.statSync(filePaths[0]);if(stat.size>MAX_SIZE*2)throw Error('Backup muito grande');
   const backup=JSON.parse(fs.readFileSync(filePaths[0],'utf8'));
   if(backup?.application!=='MDF Cut Studio - Backup Windows'||backup.version!==1||!backup.data || typeof backup.data!=='object')throw Error('Arquivo não é um backup Windows do MDF Cut');
   const data={};for(const kind of Object.keys(KEYS))if(backup.data[kind]){const raw=JSON.stringify(backup.data[kind]);checkPayload(kind,raw);data[KEYS[kind]]=raw}
   if(!Object.keys(data).length)throw Error('Backup vazio');return {data};
 });
 ipcMain.handle('mdf:read-local',event=>{requireTrusted(event);let data={};for(const kind of Object.keys(KEYS)){const p=path.join(backupDir,safeFile(kind));if(fs.existsSync(p)){const raw=fs.readFileSync(p,'utf8');checkPayload(kind,raw);data[KEYS[kind]]=raw}}return {data}});
 ipcMain.handle('mdf:folder',async event=>{requireTrusted(event);ensureDir();await shell.openPath(backupDir);return {ok:true}});
}
function openApp(){
 const win=new BrowserWindow({title:'MDF Cut Studio',width:1440,height:900,minWidth:1024,minHeight:660,backgroundColor:'#101f2a',show:false,webPreferences:{preload:path.join(__dirname,'preload.js'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,devTools:false,spellcheck:false}});
 win.once('ready-to-show',()=>win.show());win.loadURL('mdfcut://app/index.html');
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 win.webContents.on('will-navigate',(event,url)=>{if(!url.startsWith('mdfcut://app/'))event.preventDefault()});
 return win;
}
app.whenReady().then(()=>{
 backupDir=path.join(app.getPath('userData'),'MDFCut-Backups');releasesRepo=loadUpdateSource();registerIPC();
 protocol.handle('mdfcut',async request=>{
  const url=new URL(request.url);if(url.hostname!=='app'||url.pathname!=='/index.html')return new Response('Not found',{status:404});
  return net.fetch(pathToFileURL(path.join(__dirname,'app','index.html')).href)
 });
 Menu.setApplicationMenu(null);openApp();app.on('activate',()=>{if(!BrowserWindow.getAllWindows().length)openApp()});
});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit()});
