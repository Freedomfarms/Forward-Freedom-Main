// Public Freedom OS awakening scene.
// Geometry, timings, and the draw loop are the approved frontier.js prototype.
// Lifecycle below scopes that loop to one mounted public page and one document load.

export const OPENING_DURATION = 6000;

const session = {
  started: false,
  introDone: false,
  introElapsed: 0,
};

let activeDestroy = null;
let retainCount = 0;
let savedDoc = null;

export function clamp(x, a = 0, b = 1) {
  return Math.max(a, Math.min(b, x));
}

export function smooth(x) {
  x = clamp(x);
  return x * x * (3 - 2 * x);
}

export function mix(a, b, p) {
  return a + (b - a) * p;
}

export function blend(a, b, p) {
  return Object.fromEntries(Object.keys(a).map((key) => [key, mix(a[key], b[key], p)]));
}

export function openingAt(ms) {
  const p = clamp(ms / OPENING_DURATION);
  const at = (start, length) => smooth((p - start) / length);
  return {
    p,
    wake: at(0.015, 0.35),
    size: at(0.045, 0.56),
    ignite: at(0.2, 0.3),
    bolt: at(0.22, 0.32),
    frame: at(0.025, 0.14),
    note: at(0.5, 0.18),
    label: at(0.66, 0.2),
    bottom: at(0.89, 0.11),
    controls: at(0.87, 0.13),
    backdrop: at(0.01, 0.5),
    eyebrow: at(0.065, 0.18),
    freedom: at(0.14, 0.19),
    os: at(0.32, 0.24),
    think: at(0.29, 0.2),
    bigger: at(0.46, 0.23),
    description: at(0.66, 0.16),
    meet: at(0.78, 0.13),
  };
}

export function readAwakeningSession() {
  return { ...session };
}

export function resetAwakeningSessionForTests() {
  if (activeDestroy) {
    const previous = activeDestroy;
    activeDestroy = null;
    previous();
  }
  session.started = false;
  session.introDone = false;
  session.introElapsed = 0;
}

function retainDocument() {
  retainCount += 1;
  if (retainCount !== 1) return;
  const html = document.documentElement;
  const body = document.body;
  savedDoc = {
    htmlOverflow: html.style.overflowY,
    bodyOverflow: body.style.overflowY,
    overscroll: html.style.overscrollBehaviorY,
    scrollBehavior: html.style.scrollBehavior,
    scrollPadding: html.style.scrollPaddingTop,
    scrollbarGutter: html.style.scrollbarGutter,
  };
}

function releaseDocument() {
  if (retainCount === 0) return;
  retainCount -= 1;
  if (retainCount !== 0 || !savedDoc) return;
  const html = document.documentElement;
  const body = document.body;
  html.style.overflowY = savedDoc.htmlOverflow;
  body.style.overflowY = savedDoc.bodyOverflow;
  html.style.overscrollBehaviorY = savedDoc.overscroll;
  html.style.scrollBehavior = savedDoc.scrollBehavior;
  html.style.scrollPaddingTop = savedDoc.scrollPadding;
  html.style.scrollbarGutter = savedDoc.scrollbarGutter;
  savedDoc = null;
}

export function mountAwakeningScene(root, options = {}) {
  if (activeDestroy) {
    const previous = activeDestroy;
    activeDestroy = null;
    previous();
  }
  retainDocument();
  try {
    const api = startScene(root, options);
    activeDestroy = api.destroy;
    return api;
  } catch (error) {
    releaseDocument();
    throw error;
  }
}

function startScene(root, options) {
  const $ = (selector) => root.querySelector(selector);
  const $$ = (selector) => [...root.querySelectorAll(selector)];
  let destroyed = false;
const data=[
{title:'Reasoning',meta:'COGNITION / 01',symbol:'◇',short:'Clarity from complexity.',copy:'A place to work through a question, connect the important details, and weigh the possibilities. Bring the complexity. Find a clearer next step.',example:'“Help me think through the trade-offs before I decide.”'},
{title:'Memory',meta:'CONTEXT / 02',symbol:'⋮',short:'Context that stays with you.',copy:'Relevant saved context and earlier conversations can give the next conversation a stronger starting point. Your story has continuity, with the context available in your Freedom OS.',example:'“Where did we leave off with that plan?”'},
{title:'Knowledge',meta:'DISCOVERY / 03',symbol:'⌕',short:'The information you permit.',copy:'Explore information from the sources you permit. The knowledge available to CHIEF depends on the connections and permissions you enable.',example:'“What can you find in the sources I’ve connected?”'},
{title:'System intelligence',meta:'AWARENESS / 04',symbol:'⌘',short:'Your OS, understood.',copy:'Understand your Freedom OS and the context its available modules can provide. Bring the parts of your system into one conversation, within the access you allow.',example:'“Help me understand what’s available in my workspace.”'},
{title:'Execution',meta:'ACTION / 05',symbol:'↗',short:'Tools. Permissions. Control.',copy:'Bring available tools into the conversation. Review the scope of an action, understand the next step, and give approval where it is required.',example:'“Show me the next step and what it needs from me.”'},
{title:'Live status',meta:'PRESENCE / 06',symbol:'◌',short:'Conversation state, in view.',copy:'See the conversation’s actual state: listening, thinking, responding, or idle. A visual presence that helps you follow what CHIEF is doing.',example:'Listening → Thinking → Responding',label:'CONVERSATION STATES'}
];
$('#panels').innerHTML=data.map((d,i)=>`<button class="panel" data-cap="${i}" aria-haspopup="dialog"><span class="panel-meta"><span>${d.meta}</span><b aria-hidden="true">${d.symbol}</b></span><h3>${d.title.toUpperCase()}</h3><p>${d.short}</p><span class="explore">EXPLORE <b aria-hidden="true">↗</b></span></button>`).join('');
$('.segments').innerHTML=data.map((d,i)=>`<button data-seek="${i}" aria-label="Reveal ${d.title}"></button>`).join('');
const canvas=$('#universe'),ctx=canvas.getContext('2d'),chapters=$$('.chapter'),cards=$$('.panel'),segments=$$('.segments button'),rail=$$('.rail a');
let seed=81;const rand=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296};
// The Draft 4 seeded allocation and original sphere geometry.
const stars=Array.from({length:100},()=>({x:rand(),y:rand(),r:.3+rand()*1.1,a:.1+rand()*.5,phase:rand()*6.28}));
const sphere=Array.from({length:52},(_,j)=>{
const a=rand()*6.283,b=rand()*6.283,rad=.86+rand()*.14,pts=[];
for(let k=0;k<=42;k++){const v=k/42*Math.PI*1.7+j*.37,x=Math.cos(v)*rad,y=Math.sin(v)*rad,z=.025*Math.sin(v*8+j),yy=y*Math.cos(a)-z*Math.sin(a),zz=y*Math.sin(a)+z*Math.cos(a);pts.push([x*Math.cos(b)+zz*Math.sin(b),yy,-x*Math.sin(b)+zz*Math.cos(b)])}return pts;
});
const bolt=[[.25,-.94],[.04,-.63],[-.13,-.34],[.13,-.38],[-.27,.12],[.02,.06],[-.25,.56],[-.38,.97]];
const branches=[{p:[[-.12,-.34],[-.38,-.4],[-.49,-.25],[-.65,-.32]],at:.29},{p:[[.05,-.62],[.37,-.57],[.44,-.73],[.58,-.78]],at:.17},{p:[[-.24,.12],[-.44,.23],[-.37,.43],[-.62,.52]],at:.55},{p:[[-.03,.16],[.27,.27],[.38,.2],[.56,.35]],at:.63}];
const media=window.matchMedia('(prefers-reduced-motion: reduce)');
let reduced=media.matches,paused=reduced,w=window.innerWidth,h=window.innerHeight,mobile=w<=760,quality=1,dpr=1,metrics=[],cardRects=[],entryRect={},pageHeight=1;
let y=window.scrollY,dirty=true,resizePending=true,raf=0,lastTime=0,lastDraw=0,clock=0,frames=0,slow=0;
let pointer={x:0,y:0},drift={x:0,y:0},state={},previousCap=-1,currentChapter=-1;
// One opening per document load. The scroll timeline never resets this clock.
const openingRoot=$('#opening'),skipIntro=$('#skip-intro'),openingPhase=$('#opening-phase'),openingSecond=$('#opening-second'),openingProgress=$('#opening-progress'),introNodes=$$('[data-intro]');
const restored=performance.getEntriesByType('navigation')[0]?.type==='back_forward';
const hashSkip=!!(window.location.hash&&window.location.hash!=='#home');
if(!session.started){
session.started=true;
const skip=Boolean(options.skipIntro)||reduced||!ctx||restored||window.scrollY>4||hashSkip;
session.introDone=skip;
session.introElapsed=skip?OPENING_DURATION:0;
}
let introDone=session.introDone,introElapsed=session.introElapsed,opening=openingAt(introElapsed),lastOpeningPhase='';

function syncDocument(lock){
  if(!savedDoc)return;
  const html=document.documentElement;
  const body=document.body;
  html.style.scrollBehavior=reduced?'auto':'smooth';
  html.style.scrollPaddingTop='0px';
  html.style.scrollbarGutter='stable';
  html.style.overflowY=lock?'hidden':savedDoc.htmlOverflow;
  body.style.overflowY=lock?'hidden':savedDoc.bodyOverflow;
  html.style.overscrollBehaviorY=lock?'none':savedDoc.overscroll;
}
function paintOpening(){
opening=openingAt(introElapsed);
introNodes.forEach(el=>{el.style.setProperty('--enter',opening[el.dataset.intro]);if(el.matches('a,button'))el.inert=opening[el.dataset.intro]<.98});
const topnav=$('.topnav');if(topnav){topnav.style.opacity=opening.controls;topnav.inert=opening.controls<.98}
$('.rail').style.opacity=opening.controls;$('.rail').inert=!introDone;
openingProgress.style.transform=`scaleX(${opening.p})`;
openingSecond.textContent=String(Math.floor(opening.p*6)).padStart(2,'0');
const phase=opening.p<.18?'AWAKENING':opening.p<.55?'INTELLIGENCE TAKING SHAPE':opening.p<.88?'FREEDOM OS':'YOUR WORLD, READY.';
if(phase!==lastOpeningPhase){openingPhase.textContent=phase;lastOpeningPhase=phase}
openingRoot.style.opacity=1-smooth((opening.p-.92)/.08);
root.dataset.opening=introDone?'complete':'playing';
}
function finishOpening(){
if(introDone)return;
introDone=true;introElapsed=OPENING_DURATION;session.introDone=true;session.introElapsed=OPENING_DURATION;syncDocument(false);
root.classList.remove('intro-active','intro-pending');
chapters.slice(1).forEach(el=>el.inert=false);
if(document.activeElement===skipIntro)$('#hero-title').focus({preventScroll:true});
openingRoot.hidden=true;paintOpening();motionUI();resizePending=true;dirty=true;schedule();
}
function beginOpening(){
root.classList.remove('intro-pending');
root.classList.toggle('intro-active',!introDone);
openingRoot.hidden=introDone;chapters.slice(1).forEach(el=>el.inert=!introDone);
paintOpening();syncDocument(!introDone);
}
function measure(){
w=window.innerWidth;h=window.innerHeight;mobile=w<=760;dpr=Math.min(window.devicePixelRatio||1,1.5)*quality;canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);if(ctx)ctx.setTransform(dpr,0,0,dpr,0,0);
metrics=chapters.map(el=>({top:el.offsetTop,height:el.offsetHeight,scene:el.querySelector('.scene')?.offsetHeight||h}));
pageHeight=Math.max(1,document.documentElement.scrollHeight-h);cardRects=cards.map(el=>({x:el.offsetLeft,y:el.offsetTop,width:el.offsetWidth,height:el.offsetHeight}));
const r=$('.entry-space').getBoundingClientRect();entryRect={x:r.left+r.width/2,top:r.top+window.scrollY,height:r.height,width:r.width};dirty=true;resizePending=false;
}
function update(){
y=Math.max(0,window.scrollY);const[hero,cap,freedom,entry]=metrics,capSpan=Math.max(1,cap.height-cap.scene),capEnd=cap.top+capSpan,freedomEnd=freedom.top+Math.max(1,freedom.height-freedom.scene);
const cp=clamp((y-cap.top)/capSpan),capAlpha=smooth((y-cap.top+h*.65)/(h*.65))*(1-smooth((y-capEnd)/(h*.8))),active=Math.floor(clamp((cp-.04)/.12,0,5));
const toCap=smooth((y-(hero.height-h)*.5)/(cap.top-(hero.height-h)*.5)),toFreedom=smooth((y-capEnd+h*.1)/(freedom.top-capEnd+h*.15)),toEntry=smooth((y-freedomEnd)/(entry.top-freedomEnd+h*.05));
const heroAlpha=1-smooth((y-(hero.height-h)*.6)/(h*.7)),freedomAlpha=smooth((y-freedom.top+h*.65)/(h*.65))*(1-smooth((y-freedomEnd)/(h*.8)));
const heroCore=mobile?{x:w*.66,y:hero.scene*.665,r:Math.min(w*.34,165),alpha:1}:{x:w*.70,y:h*.515,r:Math.min(w*.205,h*.284,315),alpha:1};
const capCore={x:w*.5,y:cap.scene*(mobile?.414:.555),r:mobile?Math.min(w*.26,145):Math.min(w*.145,cap.scene*.193,218),alpha:1};
const freedomCore={x:w*(mobile?.88:.885),y:freedom.scene*(mobile?.185:.215),r:mobile?21:40,alpha:.45};
const entryCore={x:entryRect.x,y:entryRect.top-y+entryRect.height*.5,r:mobile?Math.min(w*.24,112):Math.min(entryRect.width*.34,175),alpha:1};
let core=blend(heroCore,capCore,toCap);core=blend(core,freedomCore,toFreedom);core=blend(core,entryCore,toEntry);
state={core,cp,capAlpha,active,freedom:toFreedom*(1-toEntry),flag:.17*(1-toCap)+.83*toFreedom*(1-toEntry)};
const progress=$('.progress i');if(progress)progress.style.transform=`scaleX(${clamp(y/pageHeight)})`;
$('.hero-copy').style.opacity=heroAlpha;$('.hero-copy').style.transform=`translateY(${reduced?0:-80*(1-heroAlpha)}px)`;$('.hero-copy').inert=heroAlpha<.05;
$('.hero-index').style.opacity=heroAlpha*opening.frame;
$('.orb-note').style.opacity=heroAlpha*opening.note;
$('.core-label').style.opacity=heroAlpha*opening.label;
$('.hero-bottom').style.opacity=heroAlpha*opening.bottom;$('.hero-bottom').inert=heroAlpha<.05||!introDone;
$$('.section-title,.mind-label,.track').forEach(el=>el.style.opacity=capAlpha);$('.track').inert=capAlpha<.08;
cards.forEach((card,i)=>{const v=mobile?(i===active?1:0):smooth((cp-(.035+i*.12))/.10),a=v*capAlpha,side=i%2===0?-1:1;card.style.opacity=a;card.style.visibility=a<.005?'hidden':'visible';card.style.transform=reduced?'none':`perspective(900px) translate3d(${mobile?0:side*(1-v)*75}px,${(1-v)*22}px,0) rotateY(${mobile?0:side*(1-v)*-17}deg) scale(${.92+v*.08})`;card.inert=a<.9;card.classList.toggle('current',i===active);segments[i].classList.toggle('current',i===active);segments[i].classList.toggle('seen',i<=active);segments[i].setAttribute('aria-pressed',String(i===active))});
if(previousCap!==active){$('#count').textContent=`0${active+1} / 06`;$('#cap-name').textContent=data[active].title.toUpperCase();previousCap=active}
$$('.freedom-copy,.principles,.flag-caption,.next').forEach(el=>el.style.opacity=freedomAlpha);$('.freedom-copy').style.transform=`translateY(${reduced?0:(1-freedomAlpha)*40}px)`;$('.next').inert=freedomAlpha<.05;
const chapter=y<cap.top-h*.45?0:y<freedom.top-h*.45?1:y<entry.top-h*.45?2:3;
if(chapter!==currentChapter){rail.forEach((el,i)=>{el.classList.toggle('active',i===chapter);if(i===chapter)el.setAttribute('aria-current','location');else el.removeAttribute('aria-current')});currentChapter=chapter}dirty=false;
}
function path(points,reveal,color,width,glow=0){
if(!ctx||reveal<=0)return;ctx.beginPath();ctx.moveTo(...points[0]);const end=(points.length-1)*clamp(reveal),whole=Math.floor(end);for(let i=1;i<=whole;i++)ctx.lineTo(...points[i]);if(whole<points.length-1){const f=end-whole;ctx.lineTo(mix(points[whole][0],points[whole+1][0],f),mix(points[whole][1],points[whole+1][1],f))}
ctx.strokeStyle=color;ctx.lineWidth=width;ctx.shadowColor=color;ctx.shadowBlur=glow;ctx.stroke();ctx.shadowBlur=0;
}
function backdrop(t){
ctx.clearRect(0,0,w,h);const{core}=state,g=ctx.createRadialGradient(core.x,core.y,0,core.x,core.y,Math.max(w*.45,500));g.addColorStop(0,'rgba(22,73,111,.20)');g.addColorStop(.45,'rgba(10,31,52,.10)');g.addColorStop(1,'rgba(3,8,14,0)');ctx.fillStyle=g;ctx.fillRect(0,0,w,h);
for(const s of stars){ctx.beginPath();ctx.fillStyle=`rgba(176,208,233,${s.a*.57*(.8+.2*Math.sin(t*.0004+s.phase))})`;ctx.arc(s.x*w+drift.x*(s.r+.2),(s.y*h-y*.025*(s.r+.2)-t*.0007+h*100)%h,s.r*(mobile?.7:1),0,Math.PI*2);ctx.fill()}
const horizon=h*.83-y*.012%24;ctx.lineWidth=.6;ctx.strokeStyle='rgba(100,170,220,.06)';
for(let i=-7;i<=7;i++){ctx.beginPath();ctx.moveTo(w*.5+i*w*.018,horizon);ctx.lineTo(w*.5+i*w*.18,h);ctx.stroke()}
for(let i=1;i<6;i++){const row=horizon+(h-horizon)*Math.pow(i/6,2);ctx.beginPath();ctx.moveTo(0,row);ctx.lineTo(w,row);ctx.stroke()}
ctx.beginPath();ctx.moveTo(0,horizon+12);for(let x=0;x<=w+20;x+=20)ctx.lineTo(x,horizon+Math.sin(x*.006)*8+Math.sin(x*.017+2)*5+Math.sin(x*.041)*2);ctx.strokeStyle='rgba(117,185,235,.075)';ctx.stroke();
}
function flag(t){
if(state.flag<.001)return;const fw=mobile?w*.94:w*.61,fh=fw/1.9,cx=mobile?w*.63:w*.79,cy=mobile?metrics[2].scene*.475:mix(h*.41,h*.435,state.freedom),opacity=state.flag*(mobile?.60:.64);
const point=(u,v)=>{const p=u*8-t*.00062+y*.00024,wave=Math.sin(p)*.026+Math.sin(p*1.6+v*2)*.012;return[cx+(u-.5)*fw+(v-.5)*fw*.10+drift.x*.8,cy+(v-.5)*fh+wave*fw*(.18+u*.82)+u*fh*.13+drift.y*.7]};
ctx.save();ctx.globalCompositeOperation='screen';const cols=32;
for(let row=0;row<13;row++){
for(let col=0;col<cols;col++){const u=col/cols,un=(col+1)/cols,v=row/13,vn=(row+1)/13,pts=[point(u,v),point(un,v),point(un,vn),point(u,vn)],fade=1-Math.pow(Math.abs(u-.48)*1.8,4),light=.55+.45*Math.cos(u*8-t*.00062);ctx.beginPath();pts.forEach((p,i)=>i?ctx.lineTo(...p):ctx.moveTo(...p));ctx.closePath();ctx.fillStyle=`rgba(${row%2===0?'65,140,200':'155,207,247'},${opacity*fade*(row%2===0?.1:.30)*light})`;ctx.fill()}
path(Array.from({length:cols+1},(_,i)=>point(i/cols,row/13)),1,`rgba(130,196,243,${opacity*.25})`,.65)}
const cw=.4,ch=7/13;
for(let col=0;col<cols;col++){const u=col/cols*cw,un=(col+1)/cols*cw,pts=[point(u,0),point(un,0),point(un,ch),point(u,ch)];ctx.beginPath();pts.forEach((p,i)=>i?ctx.lineTo(...p):ctx.moveTo(...p));ctx.closePath();ctx.fillStyle=`rgba(6,31,58,${opacity*.9})`;ctx.fill()}
for(let row=0;row<9;row++)for(let col=0;col<(row%2===0?6:5);col++){const u=((row%2===0?1:2)+col*2)/12*cw,v=(row+1)/10*ch,p=point(u,v),r=fw*.0054;ctx.beginPath();for(let n=0;n<10;n++){const a=-Math.PI/2+n*Math.PI/5,rr=n%2?r*.42:r,x=p[0]+Math.cos(a)*rr,yy=p[1]+Math.sin(a)*rr;n?ctx.lineTo(x,yy):ctx.moveTo(x,yy)}ctx.closePath();ctx.fillStyle=`rgba(190,228,255,${opacity*.9})`;ctx.fill()}
ctx.restore();
}
function core(t){
const c=state.core,cx=c.x+drift.x,cy=c.y+drift.y,r=c.r*mix(.68,1,opening.size);if(cy+r<-20||cy-r>h+40)return;const rotation=t*.00009+y*.00013,scale=clamp(r/151,.5,1.7);
ctx.save();ctx.globalAlpha=c.alpha;ctx.globalCompositeOperation='lighter';
const g=ctx.createRadialGradient(cx,cy,0,cx,cy,r*1.8);g.addColorStop(0,`rgba(63,154,220,${.20*opening.wake})`);g.addColorStop(.4,`rgba(31,85,132,${.11*opening.wake})`);g.addColorStop(1,'rgba(3,8,14,0)');ctx.fillStyle=g;ctx.fillRect(cx-r*2,cy-r*2,r*4,r*4);
const sr=r/1.17,count=quality<.8?34:sphere.length;
for(let j=0;j<count;j++){const pts=sphere[j],screen=[];ctx.beginPath();let front=0;
for(let i=0;i<pts.length;i++){const v=pts[i],x=v[0]*Math.cos(rotation)+v[2]*Math.sin(rotation),z=-v[0]*Math.sin(rotation)+v[2]*Math.cos(rotation),depth=3.8/(3.8-z);front+=z;const sx=cx+x*sr*depth,sy=cy+(v[1]*.97-z*.15)*sr*depth;screen.push([sx,sy]);i?ctx.lineTo(sx,sy):ctx.moveTo(sx,sy)}
const alpha=((j%4===0?.65:.22)+clamp(front/pts.length)*.16)*opening.wake,filament=introDone?1:smooth((opening.p-(.055+j*.0036))/.39);
path(screen,filament,`rgba(${j%3===0?'153,228,255':'62,157,250'},${alpha})`,(j%4===0?.8:.55)*scale);
if(j%3===0&&filament>.9){const index=Math.floor(((t*.00012+j*.618)%1)*37);ctx.beginPath();for(let k=index;k<index+5;k++)k===index?ctx.moveTo(...screen[k]):ctx.lineTo(...screen[k]);ctx.strokeStyle=`rgba(155,218,255,${.70*opening.ignite})`;ctx.lineWidth=1.1*scale;ctx.stroke()}
if(!introDone&&filament>0&&filament<1){const n=Math.min(screen.length-1,Math.floor(filament*(screen.length-1))),v=screen[n];ctx.beginPath();ctx.arc(v[0],v[1],1*scale,0,Math.PI*2);ctx.fillStyle=`rgba(184,234,255,${.65*Math.sin(filament*Math.PI)})`;ctx.fill()}}
ctx.beginPath();ctx.arc(cx,cy,2.8*(.86+.14*Math.sin(t*.0018))*scale,0,Math.PI*2);ctx.fillStyle=`rgba(222,249,255,${Math.max(opening.ignite,Math.sin(opening.p*Math.PI)*.45)})`;ctx.shadowBlur=18;ctx.shadowColor='#69cfff';ctx.fill();ctx.shadowBlur=0;
for(let i=0;i<2;i++){ctx.beginPath();ctx.ellipse(cx,cy,sr*1.17,sr*.34,rotation*(i?-.5:.7)+i*1.8,-Math.PI/2,-Math.PI/2+Math.PI*2*opening.wake);ctx.strokeStyle=`rgba(127,212,255,${.32*opening.wake})`;ctx.lineWidth=.6*scale;ctx.stroke()}
const br=r*.71,bp=bolt.map(p=>[cx+p[0]*br,cy+p[1]*br]),pulse=.9+.1*Math.sin(t*.0018),reveal=opening.bolt;ctx.lineJoin='round';ctx.lineCap='round';
path(bp.map(p=>[p[0]+4,p[1]+2]),reveal,`rgba(80,160,240,${.25*opening.ignite})`,2*scale,10);path(bp,reveal,`rgba(62,164,247,${.18*pulse})`,16*scale,25);path(bp,reveal,`rgba(119,194,255,${.58*pulse})`,6*scale,17);path(bp,reveal,`rgba(223,241,255,${.95*pulse})`,2.1*scale,7);path(bp,reveal,'rgba(255,252,255,.94)',.8*scale);
for(const b of branches)path(b.p.map(p=>[cx+p[0]*br,cy+p[1]*br]),smooth((reveal-b.at)*3),`rgba(123,190,244,${(.32+.1*Math.sin(t*.0015+b.at*8))*opening.ignite})`,scale*.7,4);
for(let j=0;j<(quality<.8?18:32);j++){const a=j*2.399+rotation*.4,rr=r*(1.08+.1*Math.sin(t*.0005+j));ctx.fillStyle=`rgba(166,209,245,${(.18+.35*Math.pow(Math.sin(j+t*.0007),2))*opening.ignite})`;ctx.fillRect(cx+Math.cos(a)*rr,cy+Math.sin(a)*rr*.93,j%4===0?1.8:1,j%4===0?1.8:1)}
// Draft 4's single, gentle ignition wave. No flashes or repeated pulses.
const wave=clamp((opening.p-.35)/.25);if(!introDone&&wave>0&&wave<1){ctx.beginPath();ctx.arc(cx,cy,r*(.7+wave*.8),0,Math.PI*2);ctx.strokeStyle=`rgba(131,194,245,${Math.sin(wave*Math.PI)*.19})`;ctx.lineWidth=.6;ctx.stroke()}
if(!mobile&&r>100){ctx.strokeStyle=`rgba(113,176,226,${.16*opening.label})`;ctx.lineWidth=.65;for(let i=0;i<60;i++){if(i%5!==0&&i%3!==0)continue;const a=i/60*Math.PI*2+rotation*.1,rr=r*1.28,len=i%5===0?7:2;ctx.beginPath();ctx.moveTo(cx+Math.cos(a)*rr,cy+Math.sin(a)*rr);ctx.lineTo(cx+Math.cos(a)*(rr+len),cy+Math.sin(a)*(rr+len));ctx.stroke()}}
ctx.restore();
}
function connections(t){
if(mobile||state.capAlpha<.01)return;const c=state.core,m=metrics[1],offset=Math.max(m.top-y,Math.min(0,m.top+m.height-m.scene-y));ctx.save();
cardRects.forEach((rect,i)=>{const v=smooth((state.cp-(.035+i*.12))/.1)*state.capAlpha;if(v<.01)return;const left=i%2===0,side=left?-1:1,row=Math.floor(i/2),edge=left?rect.x+rect.width:rect.x,py=rect.y+rect.height*.5+offset,pts=[[c.x+side*c.r*.8,c.y+(row-1)*c.r*.57],[c.x+side*(c.r+38),py],[edge,py]],active=i===state.active;
path(pts,1,`rgba(139,199,243,${v*(active?.47:.17)})`,active?.9:.65);ctx.beginPath();ctx.arc(...pts[0],1.5,0,Math.PI*2);ctx.fillStyle=`rgba(182,226,255,${v*.7})`;ctx.fill();
if(active){const p=(t*.00024)%1,part=p<.5?0:1,f=(p%.5)*2,a=pts[part],b=pts[part+1];ctx.beginPath();ctx.arc(mix(a[0],b[0],f),mix(a[1],b[1],f),1.8,0,Math.PI*2);ctx.shadowColor='#88ceff';ctx.shadowBlur=9;ctx.fillStyle=`rgba(198,235,255,${v})`;ctx.fill();ctx.shadowBlur=0}});ctx.restore();
}
function draw(){if(!ctx||!state.core)return;ctx.save();ctx.globalAlpha=mix(.12,1,opening.backdrop);backdrop(clock);flag(clock);ctx.restore();connections(clock);core(clock)}
function frame(now){
raf=0;if(destroyed||document.hidden)return;const realDt=lastTime?Math.max(0,now-lastTime):0,dt=Math.min(realDt,70);lastTime=now;
if(!paused){clock+=dt;if(!introDone){introElapsed=Math.min(OPENING_DURATION,introElapsed+realDt);session.introElapsed=introElapsed;paintOpening();dirty=true;if(introElapsed>=OPENING_DURATION)finishOpening()}}
if(resizePending)measure();const shouldDraw=dirty||paused||now-lastDraw>31;if(dirty)update();
if(shouldDraw){drift.x+=(pointer.x-drift.x)*.04;drift.y+=(pointer.y-drift.y)*.04;draw();lastDraw=now}
frames++;if(!paused&&frames>90){slow=dt>50?slow+1:Math.max(0,slow-1);if(slow>35&&quality===1){quality=.72;resizePending=true;slow=0}}if(!paused&&!raf)raf=window.requestAnimationFrame(frame);
}
function schedule(){if(!destroyed&&!raf&&!document.hidden)raf=window.requestAnimationFrame(frame)}

function motionUI(){
  const motion=$('#motion');
  if(motion){
    motion.textContent=paused?'▶':'Ⅱ';
    motion.setAttribute('aria-pressed',String(paused));
    motion.setAttribute('aria-label',paused?'Resume animation':introDone?'Pause ambient animation':'Pause opening animation');
  }
  root.classList.toggle('paused',paused);
}
const listeners=[];
function listen(target,type,fn,options){
  if(!target||!target.addEventListener)return;
  target.addEventListener(type,fn,options);
  listeners.push(()=>target.removeEventListener(type,fn,options));
}
listen(window,'scroll',()=>{if(!introDone&&window.scrollY>4)finishOpening();dirty=true;schedule()},{passive:true});
listen(window,'resize',()=>{resizePending=true;schedule()},{passive:true});
listen(window,'pointermove',e=>{if(!paused&&!mobile)pointer={x:(e.clientX/w-.5)*9,y:(e.clientY/h-.5)*7}},{passive:true});
listen(document,'pointerleave',()=>{pointer={x:0,y:0}});
listen(document,'visibilitychange',()=>{if(document.hidden){window.cancelAnimationFrame(raf);raf=0}else{lastTime=0;dirty=true;schedule()}});
listen($('#motion'),'click',()=>{paused=!paused;lastTime=0;motionUI();dirty=true;schedule()});
listen(media,'change',e=>{reduced=e.matches;paused=reduced;if(reduced)finishOpening();pointer={x:0,y:0};drift={x:0,y:0};motionUI();syncDocument(!introDone);dirty=true;schedule()});
listen(skipIntro,'click',finishOpening);
listen(document,'keydown',e=>{if(e.key==='Escape'&&!introDone){e.preventDefault();finishOpening()}});
listen(document,'click',e=>{const link=e.target?.closest?.('a[href^="#"]');if(!link||e.defaultPrevented||!root.contains(link))return;if(link.getAttribute('href')!=='#home')finishOpening()},true);
listen(window,'hashchange',()=>{if(window.location.hash&&window.location.hash!=='#home')finishOpening()});
segments.forEach((button,i)=>listen(button,'click',()=>{const m=metrics[1];window.scrollTo({top:m.top+(m.height-m.scene)*(.12+i*.12),behavior:reduced?'instant':'smooth'})}));
const dialog=$('#detail');let opener=null;
function show(d,button){opener=button;$('#detail-title').textContent=d.title;$('#detail-kicker').textContent=d.meta;$('.detail-copy').textContent=d.copy;$('#example-label').textContent=d.label||'A QUESTION TO BRING TO CHIEF';$('#example-text').textContent=d.example;if(typeof dialog.showModal==='function')dialog.showModal();$('.close')?.focus()}
cards.forEach((card,i)=>listen(card,'click',()=>show(data[i],card)));
listen($('.close'),'click',()=>dialog.close());
listen($('.back'),'click',()=>dialog.close());
listen(dialog,'close',()=>opener?.focus({preventScroll:true}));
listen(dialog,'click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close()}});
listen(window,'pagehide',()=>{window.cancelAnimationFrame(raf);raf=0});
listen(window,'pageshow',e=>{if(e.persisted)finishOpening();lastTime=0;resizePending=true;dirty=true;schedule()});
const failSafe=window.setTimeout(()=>{root.classList.remove('intro-pending')},8000);
beginOpening();motionUI();measure();
if(options.scrollToEntry){
  const entry=$('#entry');
  if(entry){
    const top=entry.getBoundingClientRect().top+window.scrollY;
    window.scrollTo({top,behavior:'instant'});
    measure();
  }
}
update();draw();schedule();
function destroy(){
  if(destroyed)return;
  destroyed=true;
  window.cancelAnimationFrame(raf);raf=0;
  window.clearTimeout(failSafe);
  listeners.splice(0).forEach(off=>{try{off()}catch{/* already gone */}});
  root.classList.remove('intro-active','intro-pending','paused');
  chapters.forEach(el=>{el.inert=false});
  introNodes.forEach(el=>{if(el)el.inert=false});
  const topnav=$('.topnav');if(topnav)topnav.inert=false;
  const railEl=$('.rail');if(railEl)railEl.inert=false;
  releaseDocument();
  if(activeDestroy===destroy)activeDestroy=null;
}
return {destroy,inspect(){return {introDone,introElapsed,raf,paused,reduced,strands:sphere.length,stars:stars.length,opening:openingAt(introElapsed)}}};
}
