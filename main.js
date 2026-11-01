"use strict";
const {app, BrowserWindow, protocol, Menu, ipcMain, dialog, shell, net} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const {Readable} = require('node:stream');
const {spawn} = require('node:child_process');
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

// The portable app is a self-extracting EXE. The running Electron process cannot
// overwrite the original .exe, so a small local helper does so after it exits.
// This helper is created from trusted application code, not fetched from GitHub.
const REPLACE_PS = String.raw`param(
  [Parameter(Mandatory=$true)][string]$Source,
  [Parameter(Mandatory=$true)][string]$Target,
  [Parameter(Mandatory=$true)][int]$ParentPid,
  [Parameter(Mandatory=$true)][string]$ExpectedHash,
  [Parameter(Mandatory=$true)][string]$LogFile,
  [Parameter(Mandatory=$true)][string]$ReadyFile
)
$ErrorActionPreference = 'Stop'
$next = "$Target.mdfcut-next"
$previous = "$Target.mdfcut-previous"
try {
  "Atualizador iniciado: $(Get-Date -Format o)" | Set-Content -LiteralPath $LogFile -Encoding UTF8
  "READY" | Set-Content -LiteralPath $ReadyFile -Encoding ASCII
  for ($i = 0; $i -lt 240; $i++) {
    if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 500
  }
  if (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) {
    throw 'O MDF Cut nao encerrou em ate dois minutos.'
  }
  'Programa encerrado; iniciando substituicao.' | Add-Content -LiteralPath $LogFile
  if (-not (Test-Path -LiteralPath $Target -PathType Leaf)) {
    throw 'Executavel original nao foi encontrado.'
  }
  Copy-Item -LiteralPath $Source -Destination $next -Force
  $actual = (Get-FileHash -LiteralPath $next -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $ExpectedHash) { throw 'Verificacao SHA-256 apos copiar falhou.' }
  if (Test-Path -LiteralPath $previous) { Remove-Item -LiteralPath $previous -Force }
  # NSIS portable launchers can briefly keep the original .exe locked.
  $moved = $false
  for ($attempt = 0; $attempt -lt 120; $attempt++) {
    try {
      Move-Item -LiteralPath $Target -Destination $previous -ErrorAction Stop
      $moved = $true
      break
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  if (-not $moved) { throw 'Nao foi possivel substituir o EXE (arquivo bloqueado ou sem permissao).' }
  'Executavel anterior preservado; aplicando nova versao.' | Add-Content -LiteralPath $LogFile
  try {
    Move-Item -LiteralPath $next -Destination $Target
    Start-Process -FilePath $Target
    "Atualizado em $(Get-Date -Format o)" | Set-Content -LiteralPath $LogFile
    Remove-Item -LiteralPath $Source -Force -ErrorAction SilentlyContinue
  } catch {
    if (Test-Path -LiteralPath $Target) { Remove-Item -LiteralPath $Target -Force }
    Move-Item -LiteralPath $previous -Destination $Target -ErrorAction SilentlyContinue
    throw
  }
} catch {
  $errorMessage = "Atualizacao nao concluida: $($_.Exception.Message)"
  $errorMessage | Add-Content -LiteralPath $LogFile -Encoding UTF8
  if (Test-Path -LiteralPath $Target -PathType Leaf) {
    try { Start-Process -FilePath $Target } catch { "Falha ao reabrir versao anterior: $($_.Exception.Message)" | Add-Content -LiteralPath $LogFile }
  }
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show(
    "$errorMessage" + [Environment]::NewLine + "A versao anterior foi preservada quando possivel.",
    "MDF Cut Studio - Atualizacao"
  ) | Out-Null
} finally {
  Remove-Item -LiteralPath $next -Force -ErrorAction SilentlyContinue
}
`;
async function downloadNewVersion(){
  // Always verify the newest public release and hash before installing anything.
  const status=await fetchRelease();
  if(!status.isNew)throw Error('Você já está na versão mais recente.');
  const checksumUrl=assertReleaseURL(latestCache.checksum.url);
  const exeUrl=assertReleaseURL(latestCache.exe.url);
  if(latestCache.exe.size>400*1024*1024)throw Error('Arquivo maior que o limite permitido.');
  const r=await net.fetch(checksumUrl);if(!r.ok)throw Error('Não foi possível obter o checksum do GitHub.');
  const hashes=await r.text(),file=latestCache.exe.name;
  const line=hashes.split(/\r?\n/).find(l=>l.trim().endsWith('  '+file));
  if(!line||!/^([0-9a-f]{64})\s{2}/i.test(line))throw Error('Checksum SHA256 não encontrado para o executável.');
  const expected=line.match(/^([0-9a-f]{64})/i)[1].toLowerCase();
  const portablePath=process.env.PORTABLE_EXECUTABLE_FILE;
  if(process.platform!=='win32'||!portablePath||!fs.existsSync(portablePath)) {
    throw Error('Atualização automática disponível apenas no MDF Cut Studio portátil para Windows.');
  }
  const dir=path.join(app.getPath('userData'),'Atualizacoes');
  fs.mkdirSync(dir,{recursive:true});
  const dest=path.join(dir,file),tmp=dest+'.download';
  const result=await net.fetch(exeUrl);
  if(!result.ok||!result.body)throw Error('Falha ao baixar atualização.');
  const hasher=crypto.createHash('sha256');let count=0;
  try{
    const stream=Readable.fromWeb(result.body);
    stream.on('data',chunk=>{count+=chunk.length;hasher.update(chunk);if(count>400*1024*1024)stream.destroy(Error('Download excede o limite.'))});
    await pipeline(stream,fs.createWriteStream(tmp));
    if(hasher.digest('hex')!==expected)throw Error('Verificação SHA256 falhou; atualização descartada.');
    if(fs.existsSync(dest))fs.rmSync(dest,{force:true});
    fs.renameSync(tmp,dest);
  }catch(e){try{fs.rmSync(tmp,{force:true})}catch{}throw e}
  // Only replace the original portable executable. Do not touch userData.
  const scriptPath=path.join(dir,'aplicar-atualizacao.ps1');
  const logFile=path.join(dir,'ultima-atualizacao.log');
  const readyFile=path.join(dir,'atualizador-pronto.flag');
  try{fs.rmSync(readyFile,{force:true})}catch{}
  fs.writeFileSync(logFile,'Atualização verificada. Tentando iniciar instalador externo.\n','utf8');
  fs.writeFileSync(scriptPath,REPLACE_PS,'utf8');

  // Use a UTF-16LE encoded PowerShell command to avoid -File invocation
  // ambiguity. Report parser errors to ultima-atualizacao.log before exiting.
  const configB64=Buffer.from(JSON.stringify({
    script:scriptPath,source:dest,target:path.resolve(portablePath),
    pid:process.pid,hash:expected,log:logFile,ready:readyFile
  }),'utf8').toString('base64');
  const bootstrap=[
    "$ErrorActionPreference = 'Stop'",
    "try {",
    "  $cfg = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+configB64+"')) | ConvertFrom-Json",
    "  'PowerShell inicializado; carregando script externo.' | Add-Content -LiteralPath $cfg.log -Encoding UTF8",
    "  & $cfg.script -Source $cfg.source -Target $cfg.target -ParentPid ([int]$cfg.pid) -ExpectedHash $cfg.hash -LogFile $cfg.log -ReadyFile $cfg.ready",
    "  if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw ('Script externo terminou com codigo ' + $LASTEXITCODE) }",
    "} catch {",
    "  $msg = 'Falha no inicializador: ' + $_.Exception.Message",
    "  try { ($msg + [Environment]::NewLine + $_.ScriptStackTrace) | Add-Content -LiteralPath $cfg.log -Encoding UTF8 } catch {}",
    "  exit 1",
    "}"
  ].join('\n');
  const commandB64=Buffer.from(bootstrap,'utf16le').toString('base64');
  let child;
  try {
    child=spawn('powershell.exe',[
      '-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
      '-EncodedCommand',commandB64
    ],{detached:true,windowsHide:true,stdio:['ignore','pipe','pipe']});
    // Capture even early PowerShell parser/invocation errors. Previously stderr
    // was discarded and exit code 0 gave no actionable diagnosis.
    const outputLog=path.join(dir,'powershell-saida.log');
    fs.writeFileSync(outputLog,'Processo iniciado em '+new Date().toISOString()+'\n','utf8');
    const record=(name,buf)=>{
      try{fs.appendFileSync(outputLog,'['+name+'] '+buf.toString('utf8')+'\n','utf8')}catch{}
    };
    child.stdout?.on('data',data=>record('stdout',data));
    child.stderr?.on('data',data=>record('stderr',data));
  }catch(e) {
    fs.appendFileSync(logFile,'Falha ao iniciar PowerShell: '+e.message+'\n');
    throw Error('Não foi possível iniciar o atualizador. O MDF Cut continuará aberto.');
  }
  // Never close the app before the external helper confirms it has started.
  const helperReady=await new Promise((resolve,reject)=>{
    let finished=false;
    const finish=(err)=>{
      if(finished)return;finished=true;
      clearInterval(interval);clearTimeout(timeout);
      if(err)reject(err);else resolve(true);
    };
    child.once('error',e=>finish(Error('Falha ao iniciar instalador: '+e.message)));
    child.once('close',(code,signal)=>{let detail='';try{detail=fs.readFileSync(path.join(dir,'powershell-saida.log'),'utf8').slice(-2000)}catch{}finish(Error('Instalador encerrou antes de iniciar (código '+code+', sinal '+signal+'). '+detail));});
    const interval=setInterval(()=>{
      if(fs.existsSync(readyFile))finish();
    },150);
    const timeout=setTimeout(()=>finish(Error('O instalador não confirmou a inicialização.')),10000);
  }).catch(e=>{
    try{child.kill()}catch{}
    fs.appendFileSync(logFile,'ERRO: '+e.message+'\n','utf8');
    throw Error(e.message+' Consulte ultima-atualizacao.log. O programa permanecerá aberto.');
  });
  if(helperReady){
    child.unref();
    setTimeout(()=>app.quit(),1200);
  }
  return {ok:true,installing:true,message:'Atualizador iniciado e confirmado. O MDF Cut fechará, substituirá o EXE e reabrirá.'};
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
