const BASE='http://127.0.0.1:4415/api', PASS='Zvky-Demo-1!';
const api=async(p,o={})=>{
  const h={'Content-Type':'application/json'}; if(o.token) h.Authorization='Bearer '+o.token;
  const r=await fetch(BASE+p,{method:o.method||'GET',headers:h,body:o.body?JSON.stringify(o.body):undefined});
  const t=await r.text(); let j; try{j=JSON.parse(t)}catch{j=t}
  if(r.status>=400) console.log('  !',(o.method||'GET'),p,r.status,JSON.stringify(j).slice(0,110));
  return {status:r.status, body:j};
};
(async()=>{
  const login=async e=>(await api('/auth/login',{method:'POST',body:{email:e,password:PASS}})).body.token;
  let root=await login('admin@zvky.test');
  const grant=async(role,keys)=>{
    const held=(await api(`/permissions/roles/${role}`,{token:root})).body.role.permissions
      .filter(p=>p.enabled).map(p=>p.key);
    await api(`/permissions/roles/${role}`,{token:root,method:'PUT',body:{permissions:[...new Set([...held,...keys])]}});
  };
  // So the submitter can see their own submissions come back answered.
  await grant('producer',['project.review_mine']);
  await grant('creative_art_director',['project.review_mine']);
  const prod=await login('producer@zvky.test');
  const q=(await api('/project-reviews/pending-actions',{token:prod})).body;
  console.log('Producer Pending Actions:', JSON.stringify(q.counts));
  console.log('  groups:', (q.groups||[]).map(g=>`${g.key||g.id||'?'}=${(g.items||[]).length}`).join(' '));
  const cd=await login('cd@zvky.test');
  const cq=(await api('/project-reviews/pending-actions',{token:cd})).body;
  console.log('CD Pending Actions      :', JSON.stringify(cq.counts));
})().catch(e=>{console.error(e);process.exit(1);});
