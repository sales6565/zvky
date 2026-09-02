/* A studio with work in it, so the manual's screenshots show the application
   doing its job rather than a row of empty states. Every module gets enough
   data to be worth photographing. */
const BASE='http://127.0.0.1:4415/api', PASS='Zvky-Demo-1!';
const api=async(p,o={})=>{
  const h={'Content-Type':'application/json'}; if(o.token) h.Authorization='Bearer '+o.token;
  const r=await fetch(BASE+p,{method:o.method||'GET',headers:h,body:o.body?JSON.stringify(o.body):undefined});
  const t=await r.text(); let j; try{j=JSON.parse(t)}catch{j=t}
  if(r.status>=400 && !o.quiet) console.log('  !', (o.method||'GET'), p, r.status, JSON.stringify(j).slice(0,140));
  return {status:r.status, body:j};
};
const say=(...a)=>console.log(...a);

(async()=>{
  await api('/auth/bootstrap',{method:'POST',body:{token:'ui-token',name:'Priya Nair',email:'admin@zvky.test',password:PASS},quiet:true});
  const login=async e=>(await api('/auth/login',{method:'POST',body:{email:e,password:PASS}})).body.token;
  const root=await login('admin@zvky.test');

  // --- clients and projects ------------------------------------------------
  const mkClient=async(name)=>(await api('/clients',{token:root,method:'POST',body:{name}})).body.client;
  const aurora=await mkClient('Aurora Games');
  const lumen=await mkClient('Lumen Interactive');
  const mkProject=async(clientId,name)=>(await api('/projects',{token:root,method:'POST',body:{clientId,name}})).body.project;
  const night=await mkProject(aurora.id,'Nightgarden');
  const dayfall=await mkProject(aurora.id,'Dayfall');
  const orbit=await mkProject(lumen.id,'Orbit Rally');
  say('clients + projects ✓');

  // --- people, one per role the manual walks through -----------------------
  const mk=async(name,email,role,projectId)=>{
    const r=await api('/users',{token:root,method:'POST',body:{name,email,role,password:PASS,projectId}});
    return r.body.user;
  };
  const lead   = await mk('Rahul Menon','lead@zvky.test','team_lead',night.id);
  const cd     = await mk('Ananya Rao','cd@zvky.test','creative_art_director',night.id);
  const prod   = await mk('Vikram Shah','producer@zvky.test','producer',night.id);
  const ana    = await mk('Meera Iyer','artist@zvky.test','game_artist',night.id);
  const bo     = await mk('Arjun Das','artist2@zvky.test','game_artist',night.id);
  const anim   = await mk('Kavya Reddy','animator@zvky.test','game_animator',dayfall.id);
  for(const u of [ana,bo]) await api(`/users/${u.id}`,{token:root,method:'PATCH',body:{reportsToId:lead.id,teamLeadId:lead.id}});
  await api(`/users/${anim.id}`,{token:root,method:'PATCH',body:{reportsToId:lead.id,teamLeadId:lead.id}});
  const T={};
  for(const [k,e] of [['lead','lead@zvky.test'],['cd','cd@zvky.test'],['prod','producer@zvky.test'],
    ['ana','artist@zvky.test'],['bo','artist2@zvky.test'],['anim','animator@zvky.test']]) T[k]=await login(e);
  T.root=root;
  say('people ✓', [lead,cd,prod,ana,bo,anim].map(u=>u.name).join(', '));

  // --- assets, spread across every stage the workflow has ------------------
  const mkAsset=async(projectId,name,type,assigneeId,extra={})=>(await api(`/assets/project/${projectId}`,
    {token:root,method:'POST',body:{name,type,assigneeId,manHours:extra.hours||12,priority:extra.priority||'med',
      description:extra.description||''}})).body.asset;
  const submit=(who,id,v)=>api(`/assets/${id}/submit`,{token:T[who],method:'POST',
    body:{link:`https://drive.zvky.test/${id.slice(0,8)}-v${v}`,description:`Version ${v} for review.`}});
  const start=(who,id)=>api(`/assets/${id}/start`,{token:T[who],method:'POST'});
  const review=(who,id,decision,text)=>api(`/assets/${id}/review`,{token:T[who],method:'POST',body:{decision,text}});

  const A={};
  A.notStarted = await mkAsset(night.id,'Moss Golem','character',null,{hours:20,priority:'low'});
  A.assigned   = await mkAsset(night.id,'Lantern Keeper','character',ana.id,{hours:24,priority:'high',
    description:'Hero character for the opening sequence. Needs a silhouette that reads at 64px.'});
  A.inProgress = await mkAsset(night.id,'Reed Boat','prop',bo.id,{hours:8});
  A.tlReview   = await mkAsset(night.id,'Marsh Shrine','environment',anim.id,{hours:32,priority:'high'});
  A.tlFeedback = await mkAsset(night.id,'Fen Lantern','prop',ana.id,{hours:10});
  A.cdReview   = await mkAsset(night.id,'Heron Spirit','character',bo.id,{hours:28});
  A.cdFeedback = await mkAsset(night.id,'Bog Wisp','fx',anim.id,{hours:14});
  A.approved   = await mkAsset(night.id,'Willow Crown','prop',ana.id,{hours:6});
  A.awaiting   = await mkAsset(night.id,'Tide Marker','prop',bo.id,{hours:9});
  A.delivered  = await mkAsset(night.id,'Reed Bridge','environment',anim.id,{hours:18});
  A.handover   = await mkAsset(night.id,'Silt Totem','prop',ana.id,{hours:11});
  A.other      = await mkAsset(dayfall.id,'Dawn Runner','animation',anim.id,{hours:16});
  say('assets ✓', Object.keys(A).length);

  /* Moved one at a time, and each person's session is closed before the next
     starts theirs — the studio allows one active task each, so the seed has to
     respect the same rule the application does. */
  const carry = async (who, id, to) => {
    await start(who,id);
    if(to==='in_progress') return;
    await submit(who,id,1);
    if(to==='pending_tl_review') return;
    if(to==='tl_changes_requested'){ await review('lead',id,'changes_requested','The silhouette reads flat at thumbnail size — push the hip line.'); return; }
    await review('lead',id,'approved','Reads well. Passing to CD.');
    if(to==='pending_cd_review') return;
    if(to==='cd_changes_requested'){ await review('cd',id,'changes_requested','Palette is drifting warm against the marsh set. Cool the mids.'); return; }
    await review('cd',id,'approved','Approved for client.');
    if(to==='approved_for_client') return;
    if(to==='awaiting_client_feedback'){ await api(`/assets/${id}/send-to-client-review`,{token:root,method:'POST'}); return; }
    if(to==='delivered'){ await api(`/assets/${id}/deliver`,{token:root,method:'POST'}); return; }
  };
  /* Order matters. Each artist may hold one open task at a time, so the ones
     that end in a closed state go first and the one meant to stay open goes
     last. This is the application's own rule; the seed obeys it rather than
     working around it. */
  await carry('anim', A.tlReview.id,   'pending_tl_review');
  await carry('anim', A.cdFeedback.id, 'cd_changes_requested');
  await carry('anim', A.delivered.id,  'delivered');
  await carry('ana',  A.tlFeedback.id, 'tl_changes_requested');
  await carry('ana',  A.approved.id,   'approved_for_client');
  await carry('bo',   A.cdReview.id,   'pending_cd_review');
  await carry('bo',   A.awaiting.id,   'awaiting_client_feedback');
  // Handed on mid-round, so the History sub-tab has something in it.
  await start('ana', A.handover.id);
  await api(`/assets/${A.handover.id}`,{token:root,method:'PATCH',body:{assigneeId:bo.id}});
  // And last, the one left open — Arjun's single active task.
  await carry('bo',   A.inProgress.id, 'in_progress');
  say('  (workflow states seeded)');

  // Everything above ran as whoever holds the asset; carry() uses T[who].
  console.log('SEED_IDS', JSON.stringify({
    aurora:aurora.id, lumen:lumen.id, night:night.id, dayfall:dayfall.id, orbit:orbit.id,
    lead:lead.id, cd:cd.id, prod:prod.id, ana:ana.id, bo:bo.id, anim:anim.id,
    assets:Object.fromEntries(Object.entries(A).map(([k,v])=>[k,{id:v.id,code:v.code}])),
  }));
})().catch(e=>{console.error('FAILED',e);process.exit(1);});
