(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const clamp = (x,a=0,b=1) => Math.max(a,Math.min(b,x));
  const smooth = x => { x=clamp(x); return x*x*(3-2*x); };
  const mix = (a,b,p) => a+(b-a)*p;
  const canvas = $('#universe');
  const ctx = canvas.getContext('2d', {alpha:false});
  const anchor = $('#core-anchor');
  const stage = $('.core-stage');
  const media = matchMedia('(prefers-reduced-motion: reduce)');
  let reduced=media.matches, paused=reduced, w=innerWidth, h=innerHeight, mobile=w<=780;
  let quality=1, dpr=1, raf=0, lastTime=0, lastDraw=0, clock=0, dirty=true, resizePending=true;
  let frames=0, slow=0, boot=0, spinPhase=0, drift={x:0,y:0}, pointer={x:0,y:0};
  let corePosition={x:w*.5,y:h*.5,r:140}, activity='idle', energy=.15, targetEnergy=.15;
  let timers=[], busy=false, toastTimer=0, responseMode='both';

  // Frontier's original seeded allocation order, sphere geometry, and lightning.
  // Keep these in sync with the supplied homepage reference when integrating.
  let seed=81; const rand=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296};
  const stars=Array.from({length:100},()=>({x:rand(),y:rand(),r:.3+rand()*1.1,a:.1+rand()*.5,phase:rand()*6.28}));
  const sphere=Array.from({length:52},(_,j)=>{
    const a=rand()*6.283,b=rand()*6.283,rad=.86+rand()*.14,pts=[];
    for(let k=0;k<=42;k++){const v=k/42*Math.PI*1.7+j*.37,x=Math.cos(v)*rad,y=Math.sin(v)*rad,z=.025*Math.sin(v*8+j),yy=y*Math.cos(a)-z*Math.sin(a),zz=y*Math.sin(a)+z*Math.cos(a);pts.push([x*Math.cos(b)+zz*Math.sin(b),yy,-x*Math.sin(b)+zz*Math.cos(b)])}return pts;
  });
  const bolt=[[.25,-.94],[.04,-.63],[-.13,-.34],[.13,-.38],[-.27,.12],[.02,.06],[-.25,.56],[-.38,.97]];
  const branches=[{p:[[-.12,-.34],[-.38,-.4],[-.49,-.25],[-.65,-.32]],at:.29},{p:[[.05,-.62],[.37,-.57],[.44,-.73],[.58,-.78]],at:.17},{p:[[-.24,.12],[-.44,.23],[-.37,.43],[-.62,.52]],at:.55},{p:[[-.03,.16],[.27,.27],[.38,.2],[.56,.35]],at:.63}];

  function measure(){
    w=innerWidth;h=innerHeight;mobile=w<=780;
    dpr=Math.min(devicePixelRatio||1,mobile?1.35:1.5)*quality;
    canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);
    if(ctx)ctx.setTransform(dpr,0,0,dpr,0,0);
    const rect=anchor.getBoundingClientRect(),scene=stage.getBoundingClientRect();
    corePosition={x:rect.x+rect.width*.5,y:rect.y+rect.height*.5,r:Math.max(24,Math.min(rect.width*.5,scene.height*.31))};
    resizePending=false;dirty=true;
  }
  function path(points,reveal,color,width,glow=0){
    if(!ctx||reveal<=0||points.length<2)return;
    ctx.beginPath();ctx.moveTo(...points[0]);const end=(points.length-1)*clamp(reveal),whole=Math.floor(end);
    for(let i=1;i<=whole;i++)ctx.lineTo(...points[i]);
    if(whole<points.length-1){const f=end-whole;ctx.lineTo(mix(points[whole][0],points[whole+1][0],f),mix(points[whole][1],points[whole+1][1],f))}
    ctx.strokeStyle=color;ctx.lineWidth=width;ctx.shadowColor=color;ctx.shadowBlur=glow;ctx.stroke();ctx.shadowBlur=0;
  }
  function environment(t){
    const c=corePosition;
    ctx.fillStyle='#03080e';ctx.fillRect(0,0,w,h);
    const glow=ctx.createRadialGradient(c.x,c.y,0,c.x,c.y,Math.max(c.r*2.9,350));
    glow.addColorStop(0,`rgba(26,76,118,${.22+energy*.04})`);glow.addColorStop(.42,'rgba(12,40,65,.15)');glow.addColorStop(1,'rgba(3,8,14,0)');ctx.fillStyle=glow;ctx.fillRect(0,0,w,h);
    for(const s of stars){
      ctx.beginPath();ctx.fillStyle=`rgba(176,208,233,${s.a*.43*(.72+.28*Math.sin(t*.0004+s.phase))})`;
      ctx.arc(s.x*w+drift.x*(s.r+.2),(s.y*h-t*.0005+h*100)%h,s.r*(mobile?.65:.8),0,Math.PI*2);ctx.fill();
    }
    // A quiet architectural horizon; all atmosphere is drawn, not an image.
    const horizon=c.y+c.r*1.07;
    ctx.lineWidth=.5;ctx.strokeStyle='rgba(100,170,220,.045)';
    for(let i=-10;i<=10;i++){
      ctx.beginPath();ctx.moveTo(c.x+i*18,horizon);ctx.lineTo(c.x+i*w*.12,h);ctx.stroke();
    }
    for(let i=1;i<=8;i++){
      const yy=horizon+(h-horizon)*Math.pow((i+(t*.000018)%1)/9,2);
      if(yy>h)continue;ctx.beginPath();ctx.moveTo(0,yy);ctx.lineTo(w,yy);ctx.stroke();
    }
    ctx.save();ctx.translate(c.x,horizon);ctx.scale(1,.14);
    // The radial floor fill uses local coordinates after the transform.
    const localFloor=ctx.createRadialGradient(0,0,0,0,0,c.r*2.1);localFloor.addColorStop(0,'rgba(81,165,226,.17)');localFloor.addColorStop(1,'rgba(81,165,226,0)');ctx.fillStyle=localFloor;
    ctx.beginPath();ctx.arc(0,0,c.r*2.1,0,Math.PI*2);ctx.fill();ctx.restore();
    for(let i=0;i<3;i++){
      ctx.beginPath();ctx.ellipse(c.x,horizon,c.r*(1.4+i*.2),c.r*(.12+i*.026),0,0,Math.PI*2);
      ctx.strokeStyle=`rgba(102,176,230,${.12-i*.025})`;ctx.lineWidth=.6;ctx.stroke();
    }
    const theta=t*.00014;ctx.beginPath();ctx.ellipse(c.x,horizon,c.r*1.6,c.r*.146,0,theta,theta+.65);
    ctx.strokeStyle='rgba(162,218,255,.3)';ctx.lineWidth=.85;ctx.stroke();
  }
  function conduits(t){
    if(mobile)return;
    const c=corePosition,rect=stage.getBoundingClientRect();
    ctx.save();ctx.globalAlpha=boot;
    [-1,1].forEach((side,i)=>{
      const yy=c.y+(i?1:-1)*c.r*.32,edge=side<0?rect.left+10:rect.right-10;
      const pts=[[c.x+side*c.r*.92,yy],[c.x+side*c.r*1.24,yy+side*17],[edge,yy+side*17]];
      path(pts,1,'rgba(137,199,244,.13)',.6);
      const p=(t*.00009+i*.5)%1,index=p<.4?0:1,f=index===0?p/.4:(p-.4)/.6;
      const x=mix(pts[index][0],pts[index+1][0],f),y=mix(pts[index][1],pts[index+1][1],f);
      ctx.beginPath();ctx.arc(x,y,1.35,0,Math.PI*2);ctx.fillStyle='rgba(177,224,255,.65)';ctx.shadowBlur=7;ctx.shadowColor='#86ceff';ctx.fill();ctx.shadowBlur=0;
      ctx.beginPath();ctx.arc(edge,yy+side*17,2,0,Math.PI*2);ctx.strokeStyle='rgba(145,205,247,.3)';ctx.stroke();
    });ctx.restore();
  }
  function core(t){
    const c=corePosition,cx=c.x+drift.x,cy=c.y+drift.y;
    const breath=1+Math.sin(t*.0011)*.008+energy*.012*Math.sin(t*.0034);
    const r=c.r*breath,rotation=spinPhase,scale=clamp(r/151,.4,1.9);
    ctx.save();ctx.globalAlpha=boot;ctx.globalCompositeOperation='lighter';
    const g=ctx.createRadialGradient(cx,cy,0,cx,cy,r*1.8);g.addColorStop(0,`rgba(63,154,220,${.20+energy*.10})`);g.addColorStop(.4,'rgba(31,85,132,.11)');g.addColorStop(1,'rgba(3,8,14,0)');ctx.fillStyle=g;ctx.fillRect(cx-r*2,cy-r*2,r*4,r*4);
    const sr=r/1.17,count=quality<.8?34:sphere.length;
    for(let j=0;j<count;j++){
      const pts=sphere[j],screen=[];ctx.beginPath();let front=0;
      for(let i=0;i<pts.length;i++){
        const v=pts[i],x=v[0]*Math.cos(rotation)+v[2]*Math.sin(rotation),z=-v[0]*Math.sin(rotation)+v[2]*Math.cos(rotation),depth=3.8/(3.8-z);front+=z;
        const sx=cx+x*sr*depth,sy=cy+(v[1]*.97-z*.15)*sr*depth;screen.push([sx,sy]);i?ctx.lineTo(sx,sy):ctx.moveTo(sx,sy);
      }
      const alpha=((j%4===0?.65:.22)+clamp(front/pts.length)*.16)*(1+energy*.17);
      ctx.strokeStyle=`rgba(${j%3===0?'153,228,255':'62,157,250'},${alpha})`;ctx.lineWidth=(j%4===0?.8:.55)*scale;ctx.stroke();
      if(j%3===0){const index=Math.floor(((t*(.00012+energy*.00004)+j*.618)%1)*37);ctx.beginPath();for(let k=index;k<index+5;k++)k===index?ctx.moveTo(...screen[k]):ctx.lineTo(...screen[k]);ctx.strokeStyle='rgba(155,218,255,.70)';ctx.lineWidth=1.1*scale;ctx.stroke()}
    }
    ctx.beginPath();ctx.arc(cx,cy,2.8*(.86+.14*Math.sin(t*.0018))*scale,0,Math.PI*2);ctx.fillStyle='#def9ff';ctx.shadowBlur=18;ctx.shadowColor='#69cfff';ctx.fill();ctx.shadowBlur=0;
    for(let i=0;i<2;i++){ctx.beginPath();ctx.ellipse(cx,cy,sr*1.17,sr*.34,rotation*(i?-.5:.7)+i*1.8,0,Math.PI*2);ctx.strokeStyle='rgba(127,212,255,.32)';ctx.lineWidth=.6*scale;ctx.stroke()}
    const br=r*.71,bp=bolt.map(p=>[cx+p[0]*br,cy+p[1]*br]),pulse=.9+.1*Math.sin(t*.0018),reveal=reduced||paused?1:smooth(clock/1700);
    ctx.lineJoin='round';ctx.lineCap='round';
    path(bp.map(p=>[p[0]+4,p[1]+2]),reveal,'rgba(80,160,240,.25)',2*scale,10);
    path(bp,reveal,`rgba(62,164,247,${.18*pulse})`,16*scale,25);
    path(bp,reveal,`rgba(119,194,255,${.58*pulse})`,6*scale,17);
    path(bp,reveal,`rgba(223,241,255,${.95*pulse})`,2.1*scale,7);
    path(bp,reveal,'rgba(255,252,255,.94)',.8*scale);
    for(const b of branches)path(b.p.map(p=>[cx+p[0]*br,cy+p[1]*br]),smooth((reveal-b.at)*3),`rgba(123,190,244,${.32+.1*Math.sin(t*.0015+b.at*8)})`,scale*.7,4);
    for(let j=0;j<(quality<.8?18:32);j++){
      const a=j*2.399+rotation*.4,rr=r*(1.08+.1*Math.sin(t*.0005+j));ctx.fillStyle=`rgba(166,209,245,${.18+.35*Math.pow(Math.sin(j+t*.0007),2)})`;ctx.fillRect(cx+Math.cos(a)*rr,cy+Math.sin(a)*rr*.93,j%4===0?1.8:1,j%4===0?1.8:1);
    }
    // The opposing outer traces add presence without changing the sphere itself.
    for(let band=0;band<2;band++){
      const rr=r*(1.24+band*.07),angle=t*(band?-.00004:.00006);
      for(let sector=0;sector<3;sector++){
        const start=angle+sector*Math.PI*2/3;
        ctx.beginPath();ctx.arc(cx,cy,rr,start,start+.52+band*.24);ctx.strokeStyle=band?'rgba(96,173,230,.13)':'rgba(153,217,255,.22)';ctx.lineWidth=band?.5:.7;ctx.stroke();
        if(sector===0){ctx.beginPath();ctx.arc(cx+Math.cos(start)*rr,cy+Math.sin(start)*rr,1.65,0,Math.PI*2);ctx.fillStyle='rgba(192,232,255,.65)';ctx.fill()}
      }
    }
    ctx.strokeStyle='rgba(113,176,226,.19)';ctx.lineWidth=.65;
    for(let i=0;i<60;i++){
      if(i%5!==0&&i%3!==0)continue;
      const a=i/60*Math.PI*2+rotation*.1,rr=r*1.28,len=i%5===0?6:2;
      ctx.beginPath();ctx.moveTo(cx+Math.cos(a)*rr,cy+Math.sin(a)*rr);ctx.lineTo(cx+Math.cos(a)*(rr+len),cy+Math.sin(a)*(rr+len));ctx.stroke();
    }
    if(activity==='listening'||activity==='responding'){
      const amplitude=activity==='listening'?.08:.05;
      for(let i=0;i<2;i++){
        const p=(t*.00024+i*.5)%1,rr=r*(1.05+p*.38);
        ctx.beginPath();ctx.arc(cx,cy,rr,0,Math.PI*2);ctx.strokeStyle=`rgba(133,211,255,${amplitude*(1-p)})`;ctx.lineWidth=1;ctx.stroke();
      }
    }
    ctx.restore();
  }
  function frame(now){
    raf=0;if(document.hidden)return;
    const raw=lastTime?now-lastTime:16,dt=Math.min(raw,60);lastTime=now;
    if(!paused){clock+=dt;spinPhase+=dt*(.000065+energy*.00004)}
    if(resizePending)measure();
    if(dirty||now-lastDraw>=30){
      boot=reduced||paused?1:smooth(clock/1100);
      if(paused){drift={x:0,y:0};energy=targetEnergy}else{drift.x+=(pointer.x-drift.x)*.055;drift.y+=(pointer.y-drift.y)*.055;energy+=(targetEnergy-energy)*.05}
      if(ctx){environment(clock);conduits(clock);core(clock)}lastDraw=now;dirty=false;
    }
    if(!paused){
      frames++;if(frames>120){slow=raw>50&&raw<200?slow+1:Math.max(0,slow-2);if(slow>32&&quality===1){quality=.75;resizePending=true;slow=0}}
      raf=requestAnimationFrame(frame);
    }
  }
  function schedule(){if(!raf&&!document.hidden)raf=requestAnimationFrame(frame)}
  function motionUI(){
    const button=$('#motion');button.setAttribute('aria-pressed',String(paused));button.setAttribute('aria-label',paused?'Resume ambient animation':'Pause ambient animation');button.title=paused?'Resume ambient animation':'Pause ambient animation';
    button.innerHTML=paused?'<span style="font-size:10px">▶</span>':'<svg class="icon"><use href="#i-pause"/></svg>';
    document.body.classList.toggle('paused',paused);document.body.classList.toggle('reduced-motion',reduced);
  }
  const states={
    idle:{title:'Standing by',subtitle:'A space for your next thought.',presence:'Ready when you are.',label:'STANDING BY',energy:.15},
    listening:{title:'Listening',subtitle:'Listening animation preview.',presence:'Listening preview. Take your time.',label:'LISTENING',energy:.50},
    thinking:{title:'Reasoning',subtitle:'Connecting the dots. Preview.',presence:'A moment to think it through.',label:'REASONING',energy:.85},
    responding:{title:'Responding',subtitle:'Bringing a thought into view.',presence:'A little more clarity.',label:'RESPONDING',energy:.65}
  };
  function setState(next){
    activity=next;const state=states[next];targetEnergy=state.energy;
    $('#system-status').textContent=state.title;$('#system-subtitle').textContent=state.subtitle;$('#presence-text').textContent=state.presence;$('#presence-label').textContent=state.label;
    $$('#state-list>div').forEach(el=>{const active=el.dataset.state===next;el.classList.toggle('active',active);el.querySelector('.state-indicator').textContent=active?'ACTIVE':'—'});
    $('#mic').classList.toggle('active',next==='listening');document.body.dataset.activity=next;dirty=true;schedule();
  }
  function later(fn,ms){const timer=setTimeout(fn,ms);timers.push(timer);return timer}
  function setBusy(value){
    busy=value;const button=$('#send');button.classList.toggle('busy',value);button.setAttribute('aria-label',value?'Stop preview':'Preview a response');
    button.innerHTML=value?'<svg class="icon" viewBox="0 0 24 24"><path d="M7 7h10v10H7z"/></svg>':'<svg class="icon"><use href="#i-arrow"/></svg>';
  }
  function cancelDemo(){timers.forEach(clearTimeout);timers=[];setBusy(false);setState('idle')}
  function closeResponse(){
    $('#response-card').hidden=true;stage.classList.remove('has-response');$('#assistant-message').textContent='';$('#user-message').textContent='';
  }
  function notify(message){
    clearTimeout(toastTimer);$('#toast').textContent=message;$('#toast').hidden=false;toastTimer=setTimeout(()=>$('#toast').hidden=true,3500);
  }
  const replies={
    focus:'Let’s make some room. What is the one thing that would make today feel well spent? Start there. We can work through the rest, one clear step at a time.',
    idea:'Bring me the rough version. What are you imagining, what matters most, and what is getting in the way? We can shape the idea from there.',
    project:'Start with the outcome you want. Then name the first small step you can take today. A clear direction and one deliberate move are enough to begin.',
    general:'This is where your conversation with CHIEF will unfold. Your thought comes in, the core comes alive, and the response appears in the same workspace. The live model will be connected during integration.'
  };
  function showReply(prompt,topic='general'){
    $('#user-message').textContent=prompt;$('#assistant-message').textContent=replies[topic]||replies.general;
    $('#response-card').hidden=false;stage.classList.add('has-response');setState('responding');
    later(()=>{setState('idle');setBusy(false)},4600);
  }
  function previewPrompt(prompt,topic){
    cancelDemo();closeResponse();$('#message').value='';setBusy(true);setState('thinking');
    later(()=>showReply(prompt,topic),reduced?350:2100);
  }
  function previewListening(){
    if(activity==='listening'){cancelDemo();return}
    cancelDemo();closeResponse();setBusy(true);setState('listening');
    notify('Listening animation only. Your microphone is not being used.');
    later(()=>setState('thinking'),3000);
    later(()=>showReply('Listening state demonstration','general'),5100);
  }
  function playCycle(){
    cancelDemo();closeResponse();setBusy(true);setState('listening');
    later(()=>setState('thinking'),2600);
    later(()=>showReply('How does CHIEF come alive?','general'),5100);
  }
  $('#composer').addEventListener('submit',e=>{
    e.preventDefault();if(busy){cancelDemo();return}
    const message=$('#message').value.trim();
    if(!message){$('#message').focus();return}
    const topic=/focus|priorit/i.test(message)?'focus':/idea|think/i.test(message)?'idea':/plan|project|next/i.test(message)?'project':'general';
    previewPrompt(message,topic);
  });
  $$('.suggestions button').forEach(button=>button.addEventListener('click',()=>previewPrompt(button.dataset.prompt,button.dataset.topic)));
  $$('.recent-item').forEach(button=>button.addEventListener('click',()=>previewPrompt(button.dataset.example==='focus'?'Help me find a little more clarity.':'Help me shape the next chapter.',button.dataset.example)));
  $('#new-conversation').addEventListener('click',()=>{cancelDemo();closeResponse();$('#message').value='';$('#message').focus();notify('A fresh space to think.')});
  $('#close-response').addEventListener('click',()=>{cancelDemo();closeResponse();$('#message').focus()});
  $('#mic').addEventListener('click',previewListening);
  $('#demo-cycle').addEventListener('click',playCycle);
  $$('.response-modes button').forEach(button=>button.addEventListener('click',()=>{
    responseMode=button.dataset.mode;
    $$('.response-modes button').forEach(b=>{b.classList.toggle('active',b===button);b.setAttribute('aria-pressed',String(b===button))});
    notify(responseMode==='text'?'Text mode selected. Responses here are illustrative.':responseMode==='voice'?'Voice mode selected. Audio will be connected in the live app.':'Text + Voice selected. Audio will be connected in the live app.');
  }));
  $('#model').addEventListener('change',()=>notify(`${$('#model').value} selected for the preview. No model is connected.`));
  $('#motion').addEventListener('click',()=>{paused=!paused;lastTime=0;clock=Math.max(clock,1800);motionUI();dirty=true;schedule()});
  $('#fullscreen').addEventListener('click',async()=>{
    try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen()}
    catch{notify('Fullscreen is unavailable in this preview window.')}
  });
  document.addEventListener('fullscreenchange',()=>$('#fullscreen').setAttribute('aria-label',document.fullscreenElement?'Exit fullscreen':'Enter fullscreen'));
  addEventListener('keydown',e=>{if(e.key==='Escape'){cancelDemo();closeResponse();$('#toast').hidden=true}});
  addEventListener('resize',()=>{resizePending=true;schedule()},{passive:true});
  window.visualViewport?.addEventListener('resize',()=>{resizePending=true;schedule()},{passive:true});
  addEventListener('pointermove',e=>{if(!paused&&!mobile)pointer={x:(e.clientX/w-.5)*6,y:(e.clientY/h-.5)*4}},{passive:true});
  document.addEventListener('pointerleave',()=>{pointer={x:0,y:0}});
  document.addEventListener('visibilitychange',()=>{if(document.hidden){cancelAnimationFrame(raf);raf=0;cancelDemo()}else{lastTime=0;dirty=true;schedule()}});
  media.addEventListener('change',e=>{reduced=e.matches;paused=reduced;pointer={x:0,y:0};drift={x:0,y:0};motionUI();dirty=true;schedule()});
  function updateTime(){ $('#local-time').textContent=new Intl.DateTimeFormat(undefined,{hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date())+' LOCAL' }
  let clockTimer=setInterval(updateTime,30000);
  addEventListener('pagehide',()=>{cancelAnimationFrame(raf);raf=0;timers.forEach(clearTimeout);timers=[];clearTimeout(toastTimer);clearInterval(clockTimer);clockTimer=0});
  addEventListener('pageshow',()=>{lastTime=0;resizePending=true;dirty=true;if(!clockTimer)clockTimer=setInterval(updateTime,30000);updateTime();setBusy(false);setState('idle');schedule()});
  updateTime();motionUI();measure();setState('idle');schedule();
})();
