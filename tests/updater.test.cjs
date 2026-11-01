const {test,before}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {spawn,spawnSync}=require('node:child_process');
const {once}=require('node:events');
const {loadMain}=require('./updater-fixture.cjs');
const windows=process.platform==='win32';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'mdf-updater-test-'));
const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){const value=fn();if(value)return value;await pause(100)}throw Error('Timeout waiting for fixture result')}
function log(dir){try{return fs.readFileSync(path.join(dir,'update.log'),'utf8')}catch{return ''}}
before(()=>{
 if(!windows)return;
 const source=String.raw`using System; using System.IO; using System.Threading;
 public class Fixture {
  public static void Main(string[] args) {
   if(args.Length==2 && args[0]=="hold") {
    using(FileStream gate=File.Open(System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName,FileMode.Open,FileAccess.Read,FileShare.Read)) {
     File.WriteAllText(args[1]+".ready","locked");
     while(!File.Exists(args[1])) Thread.Sleep(100);
    }
    return;
   }
   string ack=Environment.GetEnvironmentVariable("MDFCUT_ACK");
   if(String.IsNullOrEmpty(ack))return;
   string dir=Path.GetDirectoryName(ack);
   File.WriteAllText(Path.Combine(dir,"VERSION.launched"),"launched");
   if(Environment.GetEnvironmentVariable("MDFCUT_FIXTURE_NO_ACK")=="1")return;
   string token=Environment.GetEnvironmentVariable("MDFCUT_TOKEN");
   File.WriteAllText(ack,"{\"token\":\""+token+"\",\"version\":\"VERSION\",\"pid\":"+System.Diagnostics.Process.GetCurrentProcess().Id+"}");
  }
 }`;
 for(const version of ['3.2.10','3.2.11'])fs.writeFileSync(path.join(root,version+'.cs'),source.replaceAll('VERSION',version));
 const script=path.join(root,'compile.ps1');
 fs.writeFileSync(script,"$ErrorActionPreference='Stop'\nforeach($version in @('3.2.10','3.2.11')){Add-Type -Path (Join-Path $env:MDF_TEST_ROOT ($version+'.cs')) -OutputAssembly (Join-Path $env:MDF_TEST_ROOT ($version+'.exe')) -OutputType WindowsApplication}\n");
 const result=spawnSync(powershell,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],{windowsHide:true,encoding:'utf8',env:{...process.env,MDF_TEST_ROOT:root}});
 assert.equal(result.status,0,result.stderr);
});
function setup(options={}){
 const dir=fs.mkdtempSync(path.join(root,"atualização João & teste ' [x] "));
 const target=path.join(dir,"MDF Cut João & ' [x].exe"),source=path.join(dir,'download.exe');
 fs.copyFileSync(path.join(root,'3.2.10.exe'),target);fs.copyFileSync(path.join(root,'3.2.11.exe'),source);
 const data=path.join(dir,'perfil','MDFCut-Backups');fs.mkdirSync(data,{recursive:true});
 fs.writeFileSync(path.join(data,'ordens.json'),'{"version":1,"clients":[{"name":"preservar"}],"orders":[{"id":"OS-0001"}]}');
 const config={dir,target,source,expected:hash(source),...options};
 return {config,data,originalHash:hash(target),dataHash:hash(path.join(data,'ordens.json'))};
}
async function parent(config){
 const file=path.join(config.dir,'config.json');fs.writeFileSync(file,JSON.stringify(config));
 const child=spawn(process.execPath,[path.join(__dirname,'updater-fixture.cjs'),'parent',file],{windowsHide:true,stdio:'ignore'});
 const timer=setTimeout(()=>child.kill(),40000);
 const [code]=await once(child,'exit');clearTimeout(timer);
 return {code,...JSON.parse(fs.readFileSync(path.join(config.dir,'parent-result.json'),'utf8'))};
}
test('replacement and confirmed relaunch survive the parent exiting, including special paths',{skip:!windows},async()=>{
 const {config,data,originalHash,dataHash}=setup();const result=await parent(config);
 assert.equal(result.code,0);assert.equal(result.ready,true);
 await until(()=>log(config.dir).includes('SUCESSO:'));
 assert.equal(hash(config.target),hash(config.source));
 assert.equal(hash(config.target+'.mdfcut-previous-'+result.token),originalHash);
 assert.equal(hash(path.join(data,'ordens.json')),dataHash);
 assert.ok(fs.existsSync(path.join(config.dir,'3.2.11.launched')));
});
test('locked portable executable is retried after the parent exits',{skip:!windows},async()=>{
 const {config}=setup();const release=path.join(config.dir,'unlock');
 const holder=spawn(config.target,['hold',release],{windowsHide:true,stdio:'ignore'});
 const exited=once(holder,'exit');
 try{
  await until(()=>fs.existsSync(release+'.ready'));
  const result=await parent(config);assert.equal(result.ready,true);
  await until(()=>log(config.dir).includes('Processo principal encerrado'));
  await pause(600);assert.notEqual(hash(config.target),hash(config.source));
 }finally{fs.writeFileSync(release,'release');await exited}
 await until(()=>log(config.dir).includes('SUCESSO:'));assert.equal(hash(config.target),hash(config.source));
});
test('checksum mismatch fails before READY and preserves original and data',{skip:!windows},async()=>{
 const {config,data,originalHash,dataHash}=setup({expected:'0'.repeat(64)});
 const result=await parent(config);assert.equal(result.ready,false);assert.match(result.error,/SHA-256/);
 assert.equal(hash(config.target),originalHash);assert.equal(hash(path.join(data,'ordens.json')),dataHash);
 assert.ok(!fs.existsSync(path.join(config.dir,'3.2.11.launched')));
});
test('cancelled preparation never replaces the original',{skip:!windows},async()=>{
 const {config,originalHash}=setup({cancel:true});await parent(config);
 await until(()=>log(config.dir).includes('cancelada'));assert.equal(hash(config.target),originalHash);
});
test('launch failure restores and reopens previous executable',{skip:!windows},async()=>{
 const {config,originalHash}=setup({failLaunch:true});await parent(config);
 await until(()=>log(config.dir).includes('Reabertura de recuperacao solicitada'));
 await until(()=>fs.existsSync(path.join(config.dir,'3.2.10.launched')));
 assert.equal(hash(config.target),originalHash);assert.match(log(config.dir),/anterior restaurado/);
});
test('unconfirmed launch is recorded without a false success or rollback',{skip:!windows},async()=>{
 const {config,originalHash}=setup({noAck:true});const result=await parent(config);
 await until(()=>log(config.dir).includes('REINICIO NAO CONFIRMADO'));
 assert.ok(!log(config.dir).includes('SUCESSO:'));
 assert.equal(hash(config.target),hash(config.source));assert.equal(hash(config.target+'.mdfcut-previous-'+result.token),originalHash);
});
test('the in-app test initializes the independent worker without staging a replacement',{skip:!windows},async()=>{
 const {config,originalHash}=setup();const api=loadMain();
 const scriptPath=path.join(config.dir,'test.ps1'),readyFile=path.join(config.dir,'test.ready'),logFile=path.join(config.dir,'test.log');
 fs.writeFileSync(scriptPath,api.REPLACE_PS);
 const run=api.startPowerShellUpdater({dir:config.dir,scriptPath,source:config.target,target:config.target,parentPid:process.pid,expected:'0'.repeat(64),logFile,readyFile,testOnly:true});
 await api.waitPowerShellReady({...run,readyFile,logFile});
 await until(()=>fs.readFileSync(logFile,'utf8').includes('Teste de inicializacao concluido'));
 assert.equal(hash(config.target),originalHash);
 assert.ok(!fs.readdirSync(config.dir).some(n=>n.includes('.mdfcut-next-')));
});
test('a second updater action is blocked while installation remains active',async()=>{
 const api=loadMain();let release;
 const first=api.exclusiveUpdate(()=>new Promise(r=>release=r));
 await assert.rejects(api.exclusiveUpdate(async()=>({})),/andamento/);
 release({installing:true});await first;
 await assert.rejects(api.exclusiveUpdate(async()=>({})),/andamento/);
});
test('startup acknowledgement only accepts expected version, portable path and update directory',()=>{
 const profile=path.join(root,'profile'),updates=path.join(profile,'Atualizacoes');fs.mkdirSync(updates,{recursive:true});
 const env={MDFCUT_ACK:path.join(updates,'ack.json'),MDFCUT_TOKEN:'a'.repeat(32),MDFCUT_VERSION:'3.2.11',MDFCUT_TARGET:path.join(root,'app.exe'),PORTABLE_EXECUTABLE_FILE:path.join(root,'app.exe')};
 // atomicWrite uses the backup directory, initialized by normal app startup.
 const app={getVersion:()=> '3.2.11',getPath:()=>profile};
 const code=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8');
 const vm=require('node:vm');
 const sandbox={require:n=>n==='electron'?{app:{setAppUserModelId(){},whenReady(){return {then(){}}},on(){},...app},protocol:{registerSchemesAsPrivileged(){}}}:require(n),process:{...process,env},Buffer,URL,Response,console,setTimeout,setInterval,clearTimeout,clearInterval,module:{exports:{}}};
 vm.runInNewContext(code+'\nbackupDir='+JSON.stringify(path.join(profile,'MDFCut-Backups'))+';module.exports={confirmUpdatedStartup};',sandbox);
 const ack=()=>sandbox.module.exports.confirmUpdatedStartup();
 env.MDFCUT_VERSION='3.2.10';ack();assert.ok(!fs.existsSync(env.MDFCUT_ACK));
 env.MDFCUT_VERSION='3.2.11';env.PORTABLE_EXECUTABLE_FILE=path.join(root,'other.exe');ack();assert.ok(!fs.existsSync(env.MDFCUT_ACK));
 env.PORTABLE_EXECUTABLE_FILE=env.MDFCUT_TARGET;const valid=env.MDFCUT_ACK;env.MDFCUT_ACK=path.join(profile,'outside.json');ack();assert.ok(!fs.existsSync(env.MDFCUT_ACK));
 env.MDFCUT_ACK=valid;ack();assert.equal(JSON.parse(fs.readFileSync(valid,'utf8')).version,'3.2.11');
});
