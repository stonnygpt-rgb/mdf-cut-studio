const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function loadMain({app={},processOverride=process}={}){
 const sandbox={require:n=>n==='electron'?{app:{setAppUserModelId(){},whenReady(){return {then(){}}},on(){},...app},protocol:{registerSchemesAsPrivileged(){}}}:require(n),process:processOverride,Buffer,URL,Response,console,setTimeout,setInterval,clearTimeout,clearInterval,module:{exports:{}}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../main.js'),'utf8')+'\nmodule.exports={REPLACE_PS,BOOTSTRAP_PS,startPowerShellUpdater,waitPowerShellReady,exclusiveUpdate,confirmUpdatedStartup};',sandbox);
 return sandbox.module.exports;
}
module.exports={loadMain};
if(process.argv[2]==='parent'){
 (async()=>{
  const config=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
  const api=loadMain();const {dir,target,source,expected}=config;
  if(config.noAck)process.env.MDFCUT_FIXTURE_NO_ACK='1';
  const scriptPath=path.join(dir,'aplicar.ps1'),logFile=path.join(dir,'update.log'),readyFile=path.join(dir,'ready');
  let script=api.REPLACE_PS;
  if(config.noAck)script=script.replace('for ($i = 0; $i -lt 120; $i++)','for ($i = 0; $i -lt 6; $i++)');
  if(config.failLaunch)script=script.replace('$process = Open-Application',"throw 'Injected launch failure'\n  $process = Open-Application");
  fs.writeFileSync(scriptPath,script);
  const run=api.startPowerShellUpdater({dir,scriptPath,source,target,parentPid:process.pid,expected,logFile,readyFile,testOnly:false,version:'3.2.11'});
  try{
   await api.waitPowerShellReady({...run,readyFile,logFile});
   fs.writeFileSync(path.join(dir,'parent-result.json'),JSON.stringify({ready:true,token:run.token}));
   run.child.unref();
   if(config.cancel){fs.writeFileSync(readyFile+'.cancel','CANCEL');await new Promise(r=>setTimeout(r,800));}
   process.exit(0);
  }catch(error){fs.writeFileSync(path.join(dir,'parent-result.json'),JSON.stringify({ready:false,error:error.message}));process.exit(1)}
 })().catch(e=>{console.error(e);process.exit(2)});
}
