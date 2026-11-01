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

// Public GitHub Releases updater. The official source is fixed in application code.
const DEFAULT_RELEASES_REPO='stonnygpt-rgb/mdf-cut-studio';
let latestCache=null;
let updaterBusy=false;
async function exclusiveUpdate(action){
 if(updaterBusy)throw Error('Uma atualização ou teste já está em andamento.');
 updaterBusy=true;
 try{const result=await action();if(!result?.installing)updaterBusy=false;return result}
 catch(error){updaterBusy=false;throw error}
}
async function fetchRelease(){
 const repo=DEFAULT_RELEASES_REPO;
 const response=await net.fetch(`https://api.github.com/repos/${repo}/releases/latest`,{signal:AbortSignal.timeout(10000),headers:{'Accept':'application/vnd.github+json','User-Agent':'MDF-Cut-Studio-updater'}});
 if(!response.ok)throw Error(response.status===404?'Nenhuma versão pública publicada ainda (ou repositório não encontrado).':`GitHub respondeu HTTP ${response.status}`);
 const data=await response.json();const tag=String(data.tag_name||'');
 const version=tag.replace(/^v/i,'');if(!/^\d+\.\d+\.\d+$/.test(version))throw Error('Versão publicada inválida.');
 const exe=data.assets?.find(a=>/^MDF-Cut-Studio-\d+\.\d+\.\d+-Portable\.exe$/i.test(a.name) && a.name.includes(version));
 const sums=data.assets?.find(a=>a.name==='SHA256SUMS.txt');
 if(!exe||!sums)throw Error('A versão não contém o EXE portátil e o arquivo de verificação SHA256SUMS.txt.');
 latestCache={repo,version,tag,exe:{name:exe.name,url:exe.browser_download_url,size:exe.size},checksum:{url:sums.browser_download_url}};
 const installed=app.getVersion();const isNew=compareVersions(version,installed)>0;
 return {installed,available:version,isNew};
}
function compareVersions(a,b){const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]>y[i]?1:-1;return 0}
function assertReleaseURL(url,repo=latestCache.repo){const u=new URL(url);if(u.protocol!=='https:'||u.hostname!=='github.com'||!u.pathname.startsWith(`/${repo}/releases/download/`))throw Error('Endereço de download não autorizado.');return url}

// The portable app is a self-extracting EXE. The running Electron process cannot
// overwrite the original .exe, so a small local helper does so after it exits.
// This helper is created from trusted application code, not fetched from GitHub.
const REPLACE_PS = String.raw`param(
  [string]$Source = $env:MDFCUT_SOURCE,
  [string]$Target = $env:MDFCUT_TARGET,
  [int]$ParentPid = [int]$env:MDFCUT_PARENT,
  [string]$ExpectedHash = $env:MDFCUT_SHA256,
  [string]$LogFile = $env:MDFCUT_LOG,
  [string]$ReadyFile = $env:MDFCUT_READY,
  [switch]$TestOnly = ($env:MDFCUT_TEST -eq '1')
)
$ErrorActionPreference = 'Stop'
$token = $env:MDFCUT_TOKEN
$next = "$Target.mdfcut-next-$token"
$previous = "$Target.mdfcut-previous-$token"
$replaced = $false
$launched = $false
$parentExited = $false
function Write-Log([string]$message) {
  "$(Get-Date -Format o) $message" | Add-Content -LiteralPath $LogFile -Encoding UTF8
}
function Open-Application {
  # The old portable launcher's extraction directory and console may be gone.
  Remove-Item Env:PORTABLE_EXECUTABLE_FILE -ErrorAction SilentlyContinue
  Remove-Item Env:PORTABLE_EXECUTABLE_DIR -ErrorAction SilentlyContinue
  Remove-Item Env:PORTABLE_EXECUTABLE_APP_FILENAME -ErrorAction SilentlyContinue
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = $Target
  $start.WorkingDirectory = [IO.Path]::GetDirectoryName($Target)
  $start.UseShellExecute = $true
  return [System.Diagnostics.Process]::Start($start)
}
try {
  Write-Log "Auxiliar independente iniciado (PID $PID); alvo: $Target"
  if ($token -notmatch '^[a-f0-9]{32}$') { throw 'Identificador de atualizacao invalido.' }
  if (-not $TestOnly) {
    if ($ExpectedHash -notmatch '^[a-f0-9]{64}$') { throw 'SHA-256 invalido.' }
    if (-not [IO.Path]::IsPathRooted($Target) -or -not (Test-Path -LiteralPath $Target -PathType Leaf)) { throw 'Executavel original nao encontrado.' }
    if ([IO.Path]::GetFullPath($Source) -eq [IO.Path]::GetFullPath($Target)) { throw 'Origem e destino devem ser diferentes.' }
    # Stage and verify in the target directory BEFORE asking Electron to quit.
    # This also checks write permission and available space while the app is open.
    [IO.File]::Copy($Source, $next, $false)
    $sha = [Security.Cryptography.SHA256]::Create()
    $inputFile = [IO.File]::OpenRead($next)
    try { $actual = [BitConverter]::ToString($sha.ComputeHash($inputFile)).Replace('-', '').ToLowerInvariant() }
    finally { $inputFile.Dispose(); $sha.Dispose() }
    if ($actual -ne $ExpectedHash) { throw 'Verificacao SHA-256 da copia falhou.' }
    Write-Log 'Copia verificada na pasta do executavel; aguardando encerramento.'
  }
  [IO.File]::WriteAllText($ReadyFile, "READY:$token")
  if ($TestOnly) { Write-Log 'Teste de inicializacao concluido.'; exit 0 }
  for ($i = 0; $i -lt 240; $i++) {
    if (Test-Path -LiteralPath "$ReadyFile.cancel") { throw 'Atualizacao cancelada pelo aplicativo.' }
    if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 500
  }
  if (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) { throw 'O MDF Cut nao encerrou em ate dois minutos.' }
  $parentExited = $true
  if (Test-Path -LiteralPath "$ReadyFile.cancel") { exit 1 }
  Write-Log 'Processo principal encerrado; aguardando liberacao do EXE portatil.'
  for ($attempt = 0; $attempt -lt 120; $attempt++) {
    try {
      # Same-volume replacement preserves the original atomically as a backup.
      # Never delete the target first; a locked EXE leaves the original intact.
      [IO.File]::Replace($next, $Target, $previous)
      $replaced = $true
      break
    } catch { Start-Sleep -Milliseconds 500 }
  }
  if (-not $replaced) { throw 'EXE bloqueado ou substituicao nao permitida; original mantido.' }
  Write-Log "EXE substituido; anterior preservado em: $previous"
  $process = Open-Application
  $launched = $true
  Write-Log "Reabertura solicitada (PID $($process.Id)); aguardando confirmacao da interface."
  for ($i = 0; $i -lt 120; $i++) {
    if (Test-Path -LiteralPath $env:MDFCUT_ACK -PathType Leaf) {
      try {
        $ack = Get-Content -LiteralPath $env:MDFCUT_ACK -Raw | ConvertFrom-Json
        if ($ack.token -eq $token -and $ack.version -eq $env:MDFCUT_VERSION) {
          Write-Log "SUCESSO: interface da versao $($ack.version) carregada (PID $($ack.pid))."
          exit 0
        }
      } catch { } # A partially written acknowledgement is retried.
    }
    Start-Sleep -Milliseconds 500
  }
  # Do not roll back a running application: it may already be using saved data.
  Write-Log 'REINICIO NAO CONFIRMADO em 60 segundos. EXE novo, download e anterior preservados para diagnostico.'
  exit 2
} catch {
  Write-Log "FALHA: $($_.Exception.Message)"
  [IO.File]::WriteAllText("$ReadyFile.failed", $_.Exception.Message)
  if ($replaced -and -not $launched) {
    try {
      [IO.File]::Replace($previous, $Target, "$Target.mdfcut-failed-$token")
      Write-Log 'Executavel anterior restaurado.'
    } catch { Write-Log "FALHA AO RESTAURAR: $($_.Exception.Message). Copia anterior: $previous" }
  }
  if ($parentExited -and -not $launched -and (Test-Path -LiteralPath $Target -PathType Leaf)) {
    try { $null = Open-Application; Write-Log 'Reabertura de recuperacao solicitada.' }
    catch { Write-Log "FALHA AO REABRIR: $($_.Exception.Message)" }
  }
  exit 1
} finally {
  if (Test-Path -LiteralPath $next -PathType Leaf) {
    Remove-Item -LiteralPath $next -Force -ErrorAction SilentlyContinue
  }
}
`;
const BOOTSTRAP_PS = String.raw`$ErrorActionPreference = 'Stop'
try {
  # Do not use Node detached:true for Windows PowerShell: on affected Windows
  # hosts it can exit with code 0 without executing the script at all.
  # Shell-start a separate hidden worker with its own console; no parent pipes.
  $arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $env:MDFCUT_SCRIPT + '"'
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = Join-Path $PSHOME 'powershell.exe'
  $start.Arguments = $arguments
  $start.WorkingDirectory = $env:MDFCUT_DIR
  $start.UseShellExecute = $true
  $start.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $worker = [System.Diagnostics.Process]::Start($start)
  "Auxiliar iniciado em processo separado: PID $($worker.Id)" | Add-Content -LiteralPath $env:MDFCUT_LOG -Encoding UTF8
  exit 0
} catch {
  "Falha no inicializador: $($_.Exception.Message)" | Add-Content -LiteralPath $env:MDFCUT_LOG -Encoding UTF8
  exit 1
}
`;
async function downloadNewVersion(){
  // Always verify the newest public release and hash before installing anything.
  const status=await fetchRelease();
  if(!status.isNew)throw Error('Você já está na versão mais recente.');
  const release=latestCache; // Keep this download pinned even if another check refreshes the cache.
  const checksumUrl=assertReleaseURL(release.checksum.url,release.repo);
  const exeUrl=assertReleaseURL(release.exe.url,release.repo);
  if(release.exe.size>400*1024*1024)throw Error('Arquivo maior que o limite permitido.');
  const r=await net.fetch(checksumUrl);if(!r.ok)throw Error('Não foi possível obter o checksum do GitHub.');
  const hashes=await r.text(),file=release.exe.name;
  const line=hashes.split(/\r?\n/).find(l=>l.trim().endsWith('  '+file));
  if(!line||!/^([0-9a-f]{64})\s{2}/i.test(line))throw Error('Checksum SHA256 não encontrado para o executável.');
  const expected=line.match(/^([0-9a-f]{64})/i)[1].toLowerCase();
  const portablePath=process.env.PORTABLE_EXECUTABLE_FILE;
  if(process.platform!=='win32'||!portablePath||!fs.existsSync(portablePath)) {
    throw Error('Atualização automática disponível apenas no MDF Cut Studio portátil para Windows.');
  }
  const updateRoot=path.join(app.getPath('userData'),'Atualizacoes');
  fs.mkdirSync(updateRoot,{recursive:true});
  const dir=fs.mkdtempSync(path.join(updateRoot,'instalacao-'));
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
  const logFile=path.join(updateRoot,'ultima-atualizacao.log');
  const readyFile=path.join(dir,'atualizador-pronto.flag');
  try{fs.rmSync(readyFile,{force:true})}catch{}
  fs.writeFileSync(logFile,'Atualização verificada. Tentando iniciar instalador externo.\n','utf8');
  fs.writeFileSync(scriptPath,REPLACE_PS,'utf8');


  const {child,outLog,token}=startPowerShellUpdater({
    dir,scriptPath,source:dest,target:path.resolve(portablePath),
    parentPid:process.pid,expected,logFile,readyFile,testOnly:false,version:release.version
  });

  // The MDF Cut stays open until the actual external installer signals READY.
  const helperReady=await waitPowerShellReady({
    child,readyFile,logFile,outLog,token
  }).catch(e=>{
    try{fs.writeFileSync(readyFile+'.cancel','CANCEL')}catch{}
    try{child.kill()}catch{}
    try{fs.appendFileSync(logFile,'ERRO: '+e.message+'\n','utf8')}catch{}
    throw Error(e.message+' O programa permanecerá aberto.');
  });
  if(helperReady){
    child.unref();
    setTimeout(()=>app.quit(),1200);
  }
  return {ok:true,installing:true,message:'Atualizador iniciado e confirmado. O MDF Cut fechará, substituirá o EXE e reabrirá.'};
}


function startPowerShellUpdater({dir,scriptPath,source,target,parentPid,expected,logFile,readyFile,testOnly,version=''}){
  const token=crypto.randomBytes(16).toString('hex');
  const bootstrapPath=path.join(dir,'iniciar-atualizador.ps1');
  const outLog=path.join(dir,'inicializador-saida.log');
  fs.writeFileSync(bootstrapPath,BOOTSTRAP_PS,'utf8');
  const env={...process.env,
    MDFCUT_SCRIPT:scriptPath,MDFCUT_SOURCE:source,MDFCUT_TARGET:target,
    MDFCUT_PARENT:String(parentPid),MDFCUT_SHA256:expected,
    MDFCUT_LOG:logFile,MDFCUT_READY:readyFile,MDFCUT_TEST:testOnly?'1':'0',
    MDFCUT_DIR:dir,
    MDFCUT_ACK:path.join(dir,'reinicio-confirmado.json'),MDFCUT_TOKEN:token,MDFCUT_VERSION:version
  };
  // Do not inherit PowerShell 7 module paths into Windows PowerShell 5.1.
  for(const key of Object.keys(env))if(key.toLowerCase()==='psmodulepath')delete env[key];
  const fd=fs.openSync(outLog,'a');
  let child;
  try{
    const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    child=spawn(powershell,[
      '-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',bootstrapPath
    ],{detached:false,windowsHide:true,cwd:dir,stdio:['ignore',fd,fd],env});
  }finally{fs.closeSync(fd)}
  return {child,outLog,token};
}
async function waitPowerShellReady({child,readyFile,logFile,outLog,token}){
  return await new Promise((resolve,reject)=>{
    let done=false,poll,timer;
    const finish=error=>{
      if(done)return;done=true;clearInterval(poll);clearTimeout(timer);
      child.removeListener('error',onError);child.removeListener('close',onClose);
      if(error)reject(error);else resolve(true);
    };
    const detail=()=>{
      let text='';
      for(const file of [logFile,outLog]){
        try{text+='\n'+fs.readFileSync(file,'utf8').slice(-1500)}catch{}
      }
      return text;
    };
    const onError=e=>finish(Error('Não foi possível iniciar PowerShell: '+e.message));
    // The short bootstrap normally exits before the independent worker is ready.
    // Only a nonzero exit is a failure; READY belongs to the worker, not bootstrap.
    const onClose=code=>{if(code!==0)finish(Error('Falha no inicializador (código '+code+'). '+detail()))};
    child.once('error',onError);child.once('close',onClose);
    poll=setInterval(()=>{
      try{const failure=fs.readFileSync(readyFile+'.failed','utf8');finish(Error('Falha na preparação: '+failure));return}catch{}
      try{if(fs.readFileSync(readyFile,'utf8')==='READY:'+token)finish()}catch{}
    },120);
    timer=setTimeout(()=>finish(Error('O auxiliar não confirmou a preparação em 30 segundos. '+detail())),30000);
  });
}

async function testPowerShellUpdater(){
  const updateRoot=path.join(app.getPath('userData'),'Atualizacoes');
  fs.mkdirSync(updateRoot,{recursive:true});
  const dir=fs.mkdtempSync(path.join(updateRoot,'teste-'));
  const scriptPath=path.join(dir,'aplicar-atualizacao.ps1');
  const logFile=path.join(dir,'teste-inicializacao.log');
  const readyFile=path.join(dir,'teste-inicializacao.ready');
  fs.rmSync(readyFile,{force:true});
  fs.writeFileSync(scriptPath,REPLACE_PS,'utf8');
  fs.writeFileSync(logFile,'Teste seguro do inicializador do MDF Cut.\n','utf8');
  const {child,outLog,token}=startPowerShellUpdater({
    dir,scriptPath,source:scriptPath,target:scriptPath,
    parentPid:process.pid,expected:'0'.repeat(64),logFile,readyFile,testOnly:true
  });
  try{
    await waitPowerShellReady({child,readyFile,logFile,outLog,token});
    return {ok:true,message:'Teste aprovado. PowerShell executou o auxiliar e confirmou READY. Nenhum executável foi alterado.'};
  }catch(e){return {ok:false,message:e.message}}
}

function registerIPC(){
 ipcMain.handle('mdf:update-source',event=>{requireTrusted(event);return {version:app.getVersion()}});
 ipcMain.handle('mdf:check-update',async event=>{requireTrusted(event);return await fetchRelease()});
 ipcMain.handle('mdf:download-update',async event=>{requireTrusted(event);return await exclusiveUpdate(downloadNewVersion)});
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
function confirmUpdatedStartup(){
 const env=process.env,ack=env.MDFCUT_ACK,token=env.MDFCUT_TOKEN;
 if(!ack||!token||env.MDFCUT_VERSION!==app.getVersion())return;
 const root=path.join(app.getPath('userData'),'Atualizacoes');
 const relative=path.relative(root,path.resolve(ack));
 if(!relative||relative.startsWith('..')||path.isAbsolute(relative))return;
 if(!env.PORTABLE_EXECUTABLE_FILE||path.resolve(env.PORTABLE_EXECUTABLE_FILE).toLowerCase()!==path.resolve(env.MDFCUT_TARGET||'').toLowerCase())return;
 try{atomicWrite(ack,JSON.stringify({token,version:app.getVersion(),pid:process.pid}));}
 catch(error){console.error('Não foi possível confirmar o reinício da atualização:',error);}
}
function openApp(){
 const win=new BrowserWindow({icon:path.join(__dirname,'build','icon.ico'),title:'MDF Cut Studio',width:1440,height:900,minWidth:1024,minHeight:660,backgroundColor:'#101f2a',show:false,webPreferences:{preload:path.join(__dirname,'preload.js'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,devTools:false,spellcheck:false}});
 win.once('ready-to-show',()=>win.show());
 win.webContents.once('did-finish-load',()=>confirmUpdatedStartup());
 win.loadURL('mdfcut://app/index.html');
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 win.webContents.on('will-navigate',(event,url)=>{if(!url.startsWith('mdfcut://app/'))event.preventDefault()});
 return win;
}
app.whenReady().then(()=>{
 backupDir=path.join(app.getPath('userData'),'MDFCut-Backups');registerIPC();
 protocol.handle('mdfcut',async request=>{
  const url=new URL(request.url);if(url.hostname!=='app'||url.pathname!=='/index.html')return new Response('Not found',{status:404});
  return net.fetch(pathToFileURL(path.join(__dirname,'app','index.html')).href)
 });
 Menu.setApplicationMenu(null);openApp();app.on('activate',()=>{if(!BrowserWindow.getAllWindows().length)openApp()});
});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit()});

