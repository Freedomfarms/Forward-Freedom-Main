(()=>{
    'use strict';
    const root=document.getElementById('freedom-chief-draft-four');
    if(!root)return;
    // DRAFT 4: Draft 1 choreography + lightning-blue palette + Draft 2 sphere design.
    // This is the visual reference, not a replacement for the application's renderer.
    // Cursor integration: port the bolt geometry and timeline into the existing
    // CHIEF render loop. Keep the actual chat dock, auth, permissions and routes.
    const $=s=>root.querySelector(s), panels=[...root.querySelectorAll('.fc-panel')];
    const canvas=$('.fc-canvas'),ctx=canvas.getContext('2d'),stage=$('.fc-stage');
    const media=matchMedia('(prefers-reduced-motion: reduce)');
    let reduced=media.matches,width=0,height=0,dpr=1,start=performance.now(),last=start,elapsed=0,duration=5800,raf=0,dead=false,ready=false,frameCount=0,slow=0,quality=1,visible=true;
    let pointerX=0,pointerY=0,driftX=0,driftY=0,lastPhase='',activePanel=null;
    let seed=81;const rand=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296};
    const clamp=x=>Math.max(0,Math.min(1,x));const smooth=x=>{x=clamp(x);return x*x*(3-2*x)};
    const stars=Array.from({length:100},()=>({x:rand(),y:rand(),r:.3+rand()*1.1,a:.1+rand()*.5,phase:rand()*6.28}));
    // Draft 2 sphere geometry, composed at Draft 1's fixed center.
    const sphere=Array.from({length:52},(_,j)=>{
      const a=rand()*6.283,b=rand()*6.283,rad=.86+rand()*.14,pts=[];
      for(let k=0;k<=42;k++){const v=k/42*Math.PI*1.7+j*.37,x=Math.cos(v)*rad,y=Math.sin(v)*rad,z=.025*Math.sin(v*8+j),yy=y*Math.cos(a)-z*Math.sin(a),zz=y*Math.sin(a)+z*Math.cos(a);pts.push([x*Math.cos(b)+zz*Math.sin(b),yy,-x*Math.sin(b)+zz*Math.cos(b)]);}
      return pts;
    });
    const bolt=[[.25,-.94],[.04,-.63],[-.13,-.34],[.13,-.38],[-.27,.12],[.02,.06],[-.25,.56],[-.38,.97]];
    const branches=[{p:[[-.12,-.34],[-.38,-.4],[-.49,-.25],[-.65,-.32]],at:.29},{p:[[.05,-.62],[.37,-.57],[.44,-.73],[.58,-.78]],at:.17},{p:[[-.24,.12],[-.44,.23],[-.37,.43],[-.62,.52]],at:.55},{p:[[-.03,.16],[.27,.27],[.38,.2],[.56,.35]],at:.63}];
    const descriptions=[
      ['REASONING','Explore questions, weigh information, and turn complexity into a useful answer. The final experience will use your existing CHIEF conversation.'],
      ['MEMORY','Bring relevant saved context and earlier conversations into focus. This concept displays no personal memories or fabricated records.'],
      ['KNOWLEDGE','A home for permitted information and connected context. Access depends on the sources and permissions enabled in Freedom OS.'],
      ['SYSTEM INTELLIGENCE','Understand the available Freedom OS modules and their context. This panel represents a capability, not a live system diagnostic.'],
      ['EXECUTION','Discover available tools and review actions that require your approval. No tools or actions are executed by this prototype.'],
      ['LIVE STATUS','A place for the actual conversation state: listening, thinking, responding, or idle. This preview is not connected to a model.']
    ];
    function resize(){const r=stage.getBoundingClientRect();width=r.width;height=r.height;dpr=Math.min(devicePixelRatio||1,1.5)*quality;canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);if(ctx)ctx.setTransform(dpr,0,0,dpr,0,0);if(reduced)draw(1,0);}
    const ro=new ResizeObserver(resize);ro.observe(stage);
    function project(p,rotation,cx,cy,r){const x=p[0]*Math.cos(rotation)+p[2]*Math.sin(rotation),z=-p[0]*Math.sin(rotation)+p[2]*Math.cos(rotation);const y=p[1]*.97-z*.12,depth=3.8/(3.8+z);return [cx+x*r*depth,cy+y*r*depth,z];}
    function strokePath(points,reveal,color,lineWidth,glow){if(!ctx||reveal<=0)return;ctx.beginPath();ctx.moveTo(points[0][0],points[0][1]);const end=(points.length-1)*clamp(reveal),whole=Math.floor(end);for(let i=1;i<=whole;i++)ctx.lineTo(points[i][0],points[i][1]);if(whole<points.length-1){let f=end-whole;ctx.lineTo(points[whole][0]+(points[whole+1][0]-points[whole][0])*f,points[whole][1]+(points[whole+1][1]-points[whole][1])*f);}ctx.strokeStyle=color;ctx.lineWidth=lineWidth;ctx.shadowColor=color;ctx.shadowBlur=glow;ctx.stroke();ctx.shadowBlur=0;}
    function draw(progress,time){if(!ctx||!width)return;ctx.clearRect(0,0,width,height);const mobile=width<=580,cx=width*.5+driftX,cy=(mobile?180:245)+driftY,r=mobile?104:Math.min(151,width*.165);const awaken=smooth(progress/.28),ignite=smooth((progress-.15)/.24),settle=smooth((progress-.7)/.3),rotation=time*.00009;
      const g=ctx.createRadialGradient(cx,cy,10,cx,cy,r*2.3);g.addColorStop(0,`rgba(44,120,183,${.24*awaken})`);g.addColorStop(.43,`rgba(31,77,114,${.17*awaken})`);g.addColorStop(1,'rgba(5,9,12,0)');ctx.fillStyle=g;ctx.fillRect(0,0,width,height);
      for(const s of stars){ctx.beginPath();ctx.fillStyle=`rgba(166,196,220,${s.a*awaken*(.7+.3*Math.sin(time*.0004+s.phase))})`;ctx.arc(s.x*width,(s.y*height-time*.001*(s.r+.2)+height*10)%height,s.r,0,6.283);ctx.fill();}
      // Ground plane: very faint perspective rays rather than a competing halo.
      ctx.lineWidth=.5;ctx.strokeStyle=`rgba(113,163,204,${awaken*.085})`;for(let i=-5;i<=5;i++){ctx.beginPath();ctx.moveTo(cx+i*25,cy+r*.85);ctx.lineTo(cx+i*180,height);ctx.stroke();}
      ctx.save();ctx.globalCompositeOperation='lighter';
      // Use Draft 2's luminous globe and paired tilted contours. Its outer
      // silhouette stays within Draft 1's original radius and fixed composition.
      const sphereRadius=r/1.17,angle=rotation,count=quality<.8?34:sphere.length;
      for(let j=0;j<count;j++){
        const pts=sphere[j],screenPoints=[];ctx.beginPath();let front=0;
        for(let i=0;i<pts.length;i++){const v=pts[i],x=v[0]*Math.cos(angle)+v[2]*Math.sin(angle),z=-v[0]*Math.sin(angle)+v[2]*Math.cos(angle),depth=3.8/(3.8-z);front+=z;const sx=cx+x*sphereRadius*depth,sy=cy+(v[1]*.97-z*.15)*sphereRadius*depth;screenPoints.push([sx,sy]);i?ctx.lineTo(sx,sy):ctx.moveTo(sx,sy);}
        const alpha=(j%4===0?.65:.22)+clamp(front/pts.length)*.16;
        ctx.strokeStyle=`rgba(${j%3===0?'153,228,255':'62,157,250'},${alpha*awaken})`;ctx.lineWidth=j%4===0?.8:.55;ctx.stroke();
        // Preserve Draft 1's traveling filament light at its original speed.
        if(ignite>.1&&j%3===0){const index=Math.floor(((time*.00012+j*.618)%1)*37);ctx.beginPath();for(let k=index;k<index+5;k++)k===index?ctx.moveTo(screenPoints[k][0],screenPoints[k][1]):ctx.lineTo(screenPoints[k][0],screenPoints[k][1]);ctx.strokeStyle=`rgba(155,218,255,${ignite*.62})`;ctx.lineWidth=1;ctx.stroke();}
      }
      ctx.beginPath();ctx.arc(cx,cy,2.8*(.86+.14*Math.sin(time*.0018)),0,6.283);ctx.fillStyle=`rgba(222,249,255,${ignite})`;ctx.shadowBlur=18;ctx.shadowColor='#69cfff';ctx.fill();ctx.shadowBlur=0;
      for(let i=0;i<2;i++){ctx.beginPath();ctx.ellipse(cx,cy,sphereRadius*1.17,sphereRadius*.34,angle*(i?-.5:.7)+i*1.8,0,6.283);ctx.strokeStyle=`rgba(127,212,255,${.32*awaken})`;ctx.lineWidth=.6;ctx.stroke();}
      // Bolt has a stable silhouette, depth offset, branching arcs and a traveling reveal.
      const reveal=smooth((progress-.17)/.26),br=r*.71,boltPts=bolt.map(p=>[cx+p[0]*br,cy+p[1]*br]),pulse=.86+.14*Math.sin(time*.0018);
      ctx.lineJoin='round';ctx.lineCap='round';
      strokePath(boltPts.map(p=>[p[0]+4,p[1]+2]),reveal,`rgba(80,160,240,${.25*ignite})`,2,10);
      strokePath(boltPts,reveal,`rgba(62,164,247,${.18*pulse})`,16,25);
      strokePath(boltPts,reveal,`rgba(119,194,255,${.58*pulse})`,6,17);
      strokePath(boltPts,reveal,`rgba(223,241,255,${.95*pulse})`,2.1,7);
      strokePath(boltPts,reveal,'rgba(255,252,255,.94)',.8,0);
      for(const b of branches){const pts=b.p.map(p=>[cx+p[0]*br,cy+p[1]*br]);strokePath(pts,smooth((reveal-b.at)*3),`rgba(123,190,244,${(.36+.14*Math.sin(time*.0015+b.at*8))*ignite})`,1,6);}
      const sparkCount=quality<.8?18:32;for(let j=0;j<sparkCount;j++){let a=j*2.399+rotation*.4,rr=r*(1.08+.1*Math.sin(time*.0005+j)),x=cx+Math.cos(a)*rr,y=cy+Math.sin(a)*rr*.93;ctx.fillStyle=`rgba(166,209,245,${ignite*(.2+.35*Math.pow(Math.sin(j+time*.0007),2))})`;ctx.fillRect(x,y,j%4===0?1.8:1,j%4===0?1.8:1);}
      // One slow energy wave at ignition; no strobing.
      const wave=clamp((progress-.27)/.24);if(wave>0&&wave<1){ctx.beginPath();ctx.ellipse(cx,cy,r*(.7+wave*.8),r*(.7+wave*.8),0,0,6.283);ctx.lineWidth=.6;ctx.strokeStyle=`rgba(131,194,245,${Math.sin(wave*Math.PI)*.19})`;ctx.stroke();}
      ctx.restore();
      // Thin leaders attach the composed capability panels to the core.
      if(!mobile){ctx.strokeStyle=`rgba(134,182,221,${settle*.2})`;ctx.lineWidth=.6;for(let side of [-1,1])for(let row=0;row<3;row++){const y=138+row*131,edge=side<0?panels[row*2].offsetLeft+panels[row*2].offsetWidth:panels[row*2+1].offsetLeft;ctx.beginPath();ctx.moveTo(edge+side*-6,y);ctx.lineTo(cx+side*(r+24),y);ctx.lineTo(cx+side*r*.84,cy+(row-1)*r*.65);ctx.stroke();}}
    }
    function paintUI(p){root.style.setProperty('--awaken',smooth(p/.25));root.style.setProperty('--ignition',smooth((p-.18)/.22));root.style.setProperty('--progress',p);panels.forEach((el,i)=>{const v=smooth((p-(.34+i*.055))/.25),side=i%2===0?1:-1;el.style.opacity=v;el.style.transform=`translate3d(${side*(1-v)*100}px,${(1-v)*25}px,${-(1-v)*180}px) rotateY(${side*(1-v)*22}deg) scale(${.86+.14*v})`;el.inert=v<.98;});const phase=p<.18?'AWAKENING':p<.37?'INTELLIGENCE TAKING SHAPE':p<.76?'CAPABILITIES UNFOLDING':p<1?'WELCOME TO FREEDOM OS':'YOUR SPACE TO THINK';if(phase!==lastPhase){$('.fc-phase-text').textContent=phase;lastPhase=phase;}if(p>=1&&!ready){ready=true;root.dataset.ready='true';$('.fc-dock').inert=false;$('.fc-skip').hidden=true;panels.forEach(el=>el.style.willChange='auto');}}
    function loop(now){raf=0;if(dead||!visible||document.hidden)return;if(!root.isConnected){destroy();return;}const dt=Math.min(now-last,70);last=now;if(!reduced)elapsed+=dt;const p=reduced?1:clamp(elapsed/duration);driftX+=(pointerX-driftX)*.025;driftY+=(pointerY-driftY)*.025;if(!ready)paintUI(p);draw(p,reduced?0:elapsed);frameCount++;if(frameCount>40&&dt>28)slow++;else slow=Math.max(0,slow-1);if(slow>35&&quality===1){quality=.7;resize();slow=0;}if(!reduced)raf=requestAnimationFrame(loop);}
    function schedule(){if(!raf&&!dead&&visible&&!document.hidden){last=performance.now();raf=requestAnimationFrame(loop);}}
    function restart(){elapsed=0;ready=false;root.dataset.ready='false';$('.fc-dock').inert=true;$('.fc-skip').hidden=reduced;$('.fc-toast').hidden=true;panels.forEach(el=>el.style.willChange='transform,opacity');paintUI(reduced?1:0);schedule();}
    function skip(){elapsed=duration;paintUI(1);draw(1,reduced?0:elapsed);}
    const listeners=[];function on(el,type,fn){el.addEventListener(type,fn);listeners.push(()=>el.removeEventListener(type,fn));}
    on($('.fc-replay'),'click',restart);on($('.fc-skip'),'click',skip);on($('select'),'change',e=>{duration=Number(e.target.value);restart();});
    on(stage,'pointermove',e=>{if(reduced)return;const b=stage.getBoundingClientRect();pointerX=((e.clientX-b.left)/b.width-.5)*7;pointerY=((e.clientY-b.top)/b.height-.5)*5;});on(stage,'pointerleave',()=>{pointerX=pointerY=0;});
    function closeDetail(){if($('.fc-detail').hidden)return;$('.fc-detail').hidden=true;$('.fc-scrim').hidden=true;$('.fc-header').inert=false;stage.inert=false;$('.fc-dock').inert=!ready;if(activePanel)activePanel.focus();}
    panels.forEach((el,i)=>on(el,'click',()=>{activePanel=el;$('#fc-detail-title').textContent=descriptions[i][0];$('.fc-detail p').textContent=descriptions[i][1];$('.fc-detail').hidden=false;$('.fc-scrim').hidden=false;$('.fc-header').inert=true;stage.inert=true;$('.fc-dock').inert=true;$('.fc-detail-close').focus();}));
    on($('.fc-detail-close'),'click',closeDetail);on($('.fc-scrim'),'click',closeDetail);on(root,'keydown',e=>{if(!$('.fc-detail').hidden){if(e.key==='Escape')closeDetail();if(e.key==='Tab'){e.preventDefault();$('.fc-detail-close').focus();}}});
    on($('.fc-dock'),'submit',e=>{e.preventDefault();const input=$('input');if(!input.value.trim())return;$('.fc-toast').textContent='Message previewed. This concept is not connected to CHIEF; no message was sent.';$('.fc-toast').hidden=false;input.value='';});
    on(document,'visibilitychange',()=>{if(document.hidden){cancelAnimationFrame(raf);raf=0;}else schedule();});
    on(media,'change',e=>{reduced=e.matches;if(reduced){cancelAnimationFrame(raf);raf=0;skip();}schedule();});
    const io=new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;if(visible)schedule();else{cancelAnimationFrame(raf);raf=0;}},{threshold:0});io.observe(root);
    function destroy(){if(dead)return;dead=true;cancelAnimationFrame(raf);ro.disconnect();io.disconnect();listeners.forEach(remove=>remove());}
    on(window,'pagehide',destroy);
    // A host component can call this in its unmount cleanup.
    root.chiefPrototype={destroy,replay:restart,skip,renderAt(ms){paintUI(clamp(ms/duration));draw(clamp(ms/duration),reduced?0:ms);},inspect:()=>({elapsed,duration,ready,reduced,quality,raf,width,height})};
    resize();restart();
  })();
  
