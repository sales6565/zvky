const fs=require('fs');
const BASE='http://127.0.0.1:4415/api', PASS='Zvky-Demo-1!';
const SP=__dirname;
const D=JSON.parse(fs.readFileSync(SP+'/ids.json','utf8'));
const api=async(p,o={})=>{
  const h={'Content-Type':'application/json'}; if(o.token) h.Authorization='Bearer '+o.token;
  const r=await fetch(BASE+p,{method:o.method||'GET',headers:h,body:o.body?JSON.stringify(o.body):undefined});
  const t=await r.text(); let j; try{j=JSON.parse(t)}catch{j=t}
  if(r.status>=400 && !o.quiet) console.log('  !',(o.method||'GET'),p,r.status,JSON.stringify(j).slice(0,120));
  return {status:r.status, body:j};
};
(async()=>{
  const login=async e=>(await api('/auth/login',{method:'POST',body:{email:e,password:PASS}})).body.token;
  const T={ root:await login('admin@zvky.test'), prod:await login('producer@zvky.test'),
            cd:await login('cd@zvky.test') };
  // A second submission on a project Production is actually on, left waiting.
  await api('/project-reviews',{token:T.prod,method:'POST',
    body:{clientId:D.aurora, projectId:D.night,
      link:'https://drive.zvky.test/nightgarden-props', notes:'Prop set for the same chapter — checking the scale reads against the characters.'}});
  const cdQ=(await api('/project-reviews/pending-actions',{token:T.cd})).body;
  console.log('CD queue      :', JSON.stringify(cdQ.counts||{}), '| groups:', (cdQ.groups||[]).map(g=>`${g.id}:${g.items.length}`).join(' '));
  const prodQ=(await api('/project-reviews/pending-actions',{token:T.prod})).body;
  console.log('Producer queue:', JSON.stringify(prodQ.counts||{}), '| groups:', (prodQ.groups||[]).map(g=>`${g.id}:${g.items.length}`).join(' '));
  const notif=(await api('/notifications',{token:T.prod})).body;
  console.log('Producer notifications:', (notif.notifications||[]).length);
  const act=(await api('/activity?limit=1',{token:T.root})).body;
  console.log('Activity log entries  :', act.total);
})().catch(e=>{console.error('FAILED',e);process.exit(1);});
