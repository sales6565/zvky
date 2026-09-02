const path=require('path');
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
  const T={ root:await login('admin@zvky.test'), lead:await login('lead@zvky.test'),
    cd:await login('cd@zvky.test'), prod:await login('producer@zvky.test'),
    ana:await login('artist@zvky.test'), bo:await login('artist2@zvky.test'),
    anim:await login('animator@zvky.test') };

  // --- Time Sheet: a week filled in, one day submitted, one approved -------
  const iso=(d)=>d.toISOString().slice(0,10);
  const today=new Date(); const back=(today.getUTCDay()+6)%7;
  const mon=new Date(today); mon.setUTCDate(today.getUTCDate()-back);
  const day=(n)=>{ const d=new Date(mon); d.setUTCDate(mon.getUTCDate()+n); return iso(d); };
  const entry=(who,date,s,e,extra={})=>api('/timesheets/entries',{token:T[who],method:'POST',
    body:{date,startTime:s,endTime:e,...extra}});
  const cl=D.aurora, pr=D.night;
  await entry('ana',day(0),'09:30','13:00',{clientId:cl,projectId:pr,assetId:D.assets.assigned.id,notes:'Silhouette pass'});
  await entry('ana',day(0),'14:00','18:00',{clientId:cl,projectId:pr,assetId:D.assets.assigned.id,notes:'Blocking'});
  await entry('ana',day(1),'09:30','12:30',{clientId:cl,projectId:pr,notes:'Rework from TL notes'});
  await entry('ana',day(1),'13:30','17:00',{nonProject:'meeting',notes:'Sprint planning'});
  await entry('ana',day(2),'10:00','18:00',{clientId:cl,projectId:pr,assetId:D.assets.tlFeedback.id});
  await api('/timesheets/submit',{token:T.ana,method:'POST',body:{date:day(0)}});
  await api('/timesheets/submit',{token:T.ana,method:'POST',body:{date:day(1)}});
  await api(`/timesheets/${D.ana}/${day(1)}/decision`,{token:T.lead,method:'POST',
    body:{decision:'approve'}});
  await entry('bo',day(0),'09:30','13:00',{clientId:cl,projectId:pr});
  await entry('bo',day(0),'14:00','17:30',{nonProject:'training',notes:'Rigging workshop'});
  await api('/timesheets/submit',{token:T.bo,method:'POST',body:{date:day(0)}});
  console.log('timesheets ✓  (week of', day(0), ')');

  // --- Send Project to CD Review, answered and awaiting acknowledgement ----
  const send=async(who,projectId,note)=>api('/project-reviews',{token:T[who],method:'POST',
    body:{clientId:cl, projectId, link:'https://drive.zvky.test/nightgarden-review', notes:note}});
  const r1=await send('prod',pr,'Full character set for the marsh chapter — please look at the palette across all five.');
  const r2=await send('prod',D.dayfall,'Environment blockout for Dayfall chapter 2.');
  if(r1.body && r1.body.request){
    await api(`/project-reviews/${r1.body.request.id}/feedback`,{token:T.cd,method:'POST',
      body:{feedback:'The palette holds together. Push the rim light on the Lantern Keeper and this is ready.'}});
  }
  console.log('project reviews ✓');

  // --- Thumbnails: one uploaded, one linked -------------------------------
  const png=fs.readFileSync(path.join(SP,'sample-thumbnail.png'));
  const put=async(token,id,buf)=>{
    const b='----zvkydoc'+Date.now();
    const head=Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="image"; filename="p.png"\r\nContent-Type: image/png\r\n\r\n`,'latin1');
    const tail=Buffer.from(`\r\n--${b}--\r\n`,'latin1');
    const r=await fetch(`${BASE}/assets/${id}/thumbnail`,{method:'POST',
      headers:{Authorization:'Bearer '+token,'Content-Type':`multipart/form-data; boundary=${b}`},
      body:Buffer.concat([head,buf,tail])});
    return r.status;
  };
  console.log('thumbnail upload:', await put(T.ana, D.assets.assigned.id, png));
  const donor=`http://127.0.0.1:4415/api/assets/${D.assets.assigned.id}/thumbnail`;
  console.log('thumbnail link  :', (await api(`/assets/${D.assets.cdReview.id}/thumbnail`,
    {token:T.bo,method:'POST',body:{sourceUrl:donor}})).status);

  // --- A second client-feedback round, so the round history has depth -----
  await api(`/assets/${D.assets.awaiting.id}/client-changes`,{token:T.root,method:'POST',
    body:{text:'Client wants the marker taller and in the studio blue.'}});
  console.log('client feedback ✓');

  const counts=async(what,path,token)=>{
    const r=await api(path,{token});
    console.log(' ', what, JSON.stringify(r.body).length, 'bytes');
  };
  await counts('activity log', '/activity?limit=5', T.root);
  console.log('DONE');
})().catch(e=>{console.error('FAILED',e);process.exit(1);});
