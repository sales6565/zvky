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
  let root=await login('admin@zvky.test');

  /* Four permissions are Super-Admin-only out of the box: sending a project
     for CD review, seeing the Pending Actions queue, and the two client-facing
     steps. A studio running this for real grants them to Production and the
     Creative Director on day one — so the demo does exactly that, through the
     same Settings screen the manual documents. */
  const grant=async(role,keys)=>{
    const held=(await api(`/permissions/roles/${role}`,{token:root})).body.role.permissions
      .filter(p=>p.enabled).map(p=>p.key);
    const want=[...new Set([...held,...keys])];
    const r=await api(`/permissions/roles/${role}`,{token:root,method:'PUT',body:{permissions:want}});
    console.log(' ', role, r.status===200 ? `+${keys.filter(k=>!held.includes(k)).join(', ')}` : 'FAILED');
  };
  await grant('producer',['project.review_send','pending.view','review.client_send','review.client_view','review.client_deliver']);
  await grant('creative_art_director',['project.review_send']);
  await grant('team_lead',['report.view']);

  const T={ root, prod:await login('producer@zvky.test'), cd:await login('cd@zvky.test'),
            lead:await login('lead@zvky.test') };

  const send=async(who,projectId,note)=>api('/project-reviews',{token:T[who],method:'POST',
    body:{clientId:D.aurora, projectId, link:'https://drive.zvky.test/nightgarden-review', notes:note}});
  const r1=await send('prod',D.night,'Full character set for the marsh chapter — please look at the palette across all five.');
  const r2=await send('prod',D.dayfall,'Environment blockout for Dayfall chapter 2 — layout only, no lighting yet.');
  if(r1.body && r1.body.request){
    await api(`/project-reviews/${r1.body.request.id}/feedback`,{token:T.cd,method:'POST',
      body:{feedback:'The palette holds together across the set. Push the rim light on the Lantern Keeper and this is ready to go out.'}});
    console.log('  one answered, one still waiting ✓');
  }
  const q=(await api('/project-reviews/pending',{token:T.prod})).body;
  console.log('  producer sees:', q.counts ? JSON.stringify(q.counts) : 'n/a');
  console.log('DONE');
})().catch(e=>{console.error('FAILED',e);process.exit(1);});
