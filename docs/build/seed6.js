/* A second asset for Meera, so the manual can show one artist holding a task
   in progress while the Accept and Start button on her other asset is refused.
   One asset is not enough to photograph a rule about two. */
const BASE='http://127.0.0.1:4415/api', PASS='Zvky-Demo-1!';
const fs=require('fs');
const IDS=__dirname+'/ids.json';
const api=async(p,o={})=>{
  const h={'Content-Type':'application/json'}; if(o.token) h.Authorization='Bearer '+o.token;
  const r=await fetch(BASE+p,{method:o.method||'GET',headers:h,body:o.body?JSON.stringify(o.body):undefined});
  const t=await r.text(); let j; try{j=JSON.parse(t)}catch{j=t}
  if(r.status>=400) console.log('  !',(o.method||'GET'),p,r.status,JSON.stringify(j).slice(0,140));
  return {status:r.status, body:j};
};
(async()=>{
  const d=JSON.parse(fs.readFileSync(IDS,'utf8'));
  const login=async e=>(await api('/auth/login',{method:'POST',body:{email:e,password:PASS}})).body.token;
  const root=await login('admin@zvky.test');
  const users=(await api('/users',{token:root})).body;
  const list=Array.isArray(users)?users:(users.users||[]);
  const meera=list.find(u=>u.email==='artist@zvky.test');
  if(!meera) throw new Error('demo artist missing');
  const existing=(await api(`/assets/project/${d.night}`,{token:root})).body;
  const assets=Array.isArray(existing)?existing:(existing.assets||[]);
  let made=assets.find(a=>a.name==='Ridge Warden');
  if(!made){
    const r=await api(`/assets/project/${d.night}`,{token:root,method:'POST',body:{
      name:'Ridge Warden', type:'character', priority:'Medium', assigneeId:meera.id,
      manHours:16, description:'Secondary character for the ridge sequence. Same silhouette language as the Lantern Keeper.'}});
    made=r.body.asset||r.body;
  }
  d.assets.second={id:made.id, code:made.code};
  fs.writeFileSync(IDS, JSON.stringify(d));
  console.log('second asset for Meera:', made.code, made.name, made.status);
})().catch(e=>{console.error(e);process.exit(1);});
