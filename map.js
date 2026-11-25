/* Карта школы — общая для приложения учеников, Skedy Teachers и Skedy Parents.
   Схема зон — по плану школы «שמות המתחמים» (обведено вручную, координаты в пикселях того плана).
   Приложение рисует свою шапку, а тело экрана берёт из SkedyMap.html(o); нажатия ловит SkedyMap.bind.
   Кабинеты — из teacher/rooms.json (все классы школы) + o.rooms. Корпус кабинета — по первым словам названия. */
(function(){
'use strict';
var BASE=(function(){try{var s=document.currentScript&&document.currentScript.src;return s?s.replace(/map\.js(\?.*)?$/,''):'/';}catch(e){return '/';}})();
// k — ключ, n — номер на плане школы, lb — подпись на схеме, nm — название, sub — пояснение, pre — с чего начинается название кабинета
var Z=[
 {k:'shaked',n:'3',pre:['שקד'],lb:{he:'שקד',en:'Shaked',ru:'Шакед'},x:740,y:105,
  pts:'580,8 868,20 872,95 950,108 948,245 900,238 900,193 565,170'},
 {k:'sport',n:'7',pre:['אולם ספורט','חנ"ג','מגרש'],lb:{he:'ספורט',en:'Sports',ru:'Спорт'},x:262,y:300,
  sub:{he:'אולם ספורט ומגרשים',en:'Gym and sports fields',ru:'Спортзал и площадки'},
  pts:'130,78 196,78 196,195 386,206 376,414 126,396'},
 {k:'oren',n:'10',pre:['אורן'],lb:{he:'אורן',en:'Oren',ru:'Орен'},x:470,y:300,
  sub:{he:'רחבת שכבת ז׳',en:'7th grade yard',ru:'Двор 7-х классов'},
  pts:'386,130 568,144 565,170 548,418 376,415 386,206'},
 {k:'rimon',n:'8',pre:['רימון'],lb:{he:'רימון',en:'Rimon',ru:'Римон'},x:725,y:315,
  pts:'565,170 900,193 896,402 836,402 832,446 640,440 548,450 548,418'},
 {k:'erez',n:'4',pre:['ארז'],lb:{he:'ארז',en:'Erez',ru:'Эрез'},x:938,y:390,
  pts:'900,238 1028,242 992,532 832,532 836,402 896,402'},
 {k:'brosh',n:'6',pre:['ברוש'],lb:{he:'ברוש',en:'Brosh',ru:'Брош'},x:500,y:515,
  pts:'376,415 548,418 548,450 640,440 630,575 500,578 492,610 372,592'},
 {k:'alon',n:'1–2',pre:['אלון'],lb:{he:'אלון',en:'Alon',ru:'Алон'},x:732,y:505,
  sub:{he:'קומת קרקע וקומה שנייה',en:'Ground floor and 2nd floor',ru:'Первый и второй этаж'},
  pts:'640,440 832,446 832,532 828,580 630,556'},
 {k:'audit',n:'9',pre:['אודיטוריום'],lb:{he:'אודיטוריום',en:'Auditorium',ru:'Аудиториум'},x:738,y:645,
  sub:{he:'רחבת אודיטוריום',en:'Auditorium yard',ru:'Площадь у аудиториума'},
  pts:'655,560 828,580 832,532 905,526 890,588 826,594 822,696 645,700'},
 {k:'gefen',n:'12',pre:['גפן'],lb:{he:'גפן',en:'Gefen',ru:'Гефен'},x:538,y:785,
  sub:{he:'תיכון · קומה 0 (תחתונה)',en:'High school · floor 0 (lower)',ru:'Старшая школа · этаж 0 (нижний)'},
  pts:'468,692 612,698 608,856 465,860'},
 {k:'tich',n:'13–14',pre:[],lb:{he:'תיכון',en:'High school',ru:'Старшая'},x:708,y:785,
  nm:{he:'תיכון · קומות 1–2',en:'High school · floors 1–2',ru:'Старшая школа · этажи 1–2'},
  sub:{he:'קומה 1 — קומת חדר המורים · קומה 2 — עליונה',en:'Floor 1 — teachers’ room · floor 2 — top',ru:'Этаж 1 — учительская · этаж 2 — верхний'},
  pts:'612,698 812,706 800,852 608,856'},
 {k:'yard',n:'11',pre:[],lb:{he:'רחבה',en:'Yard',ru:'Двор'},x:878,y:785,
  nm:{he:'רחבת תיכון ראשית',en:'Main high school yard',ru:'Главный двор старшей школы'},
  pts:'815,702 955,700 950,850 800,862'},
 // בית רינה на плане школы — отдельной вставкой: стоит не рядом с остальными корпусами
 {k:'rina',n:'5',pre:['בית רינה'],lb:{he:'בית רינה',en:'Beit Rina',ru:'Бейт-Рина'},x:282,y:752,inset:true,
  sub:{he:'מבנה נפרד, מחוץ למתחם הראשי',en:'Separate building, outside the main campus',ru:'Отдельное здание, вне основной территории'},
  pts:'132,660 432,660 432,850 132,850'}
];
// корпуса, которых ещё нет на схеме (их кабинеты — списком «ещё не на карте»)
var OFF=[['זית',{he:'זית',en:'Zayit',ru:'Заит'}],['ריושקה',{he:'ריושקה',en:'Ryushka',ru:'Рюшка'}],['תמר',{he:'תמר',en:'Tamar',ru:'Тамар'}]];
var T={
 he:{search:'חיפוש כיתה, מעבדה…',now:'עכשיו',next:'השיעור הבא',pm:'אסיפת הורים',notOn:'עוד לא על המפה',
   notOnR:'המיקום של הכיתה הזו עוד לא על המפה',noMatch:'לא נמצא',tap:'נגיעה באזור מראה את הכיתות שבו',
   clear:'ניקוי',other:'אחר',rooms:'כיתות',noRooms:'אין כאן כיתות מהמערכת',mapL:'מפת בית הספר',inset:'מבנה נפרד'},
 en:{search:'Search a room, lab…',now:'Now',next:'Next lesson',pm:'Parents’ meeting',notOn:'Not on the map yet',
   notOnR:'This room’s location isn’t on the map yet',noMatch:'Nothing found',tap:'Tap an area to see its rooms',
   clear:'Clear',other:'Other',rooms:'Rooms',noRooms:'No timetable rooms here',mapL:'School map',inset:'Separate building'},
 ru:{search:'Поиск кабинета, лаборатории…',now:'Сейчас',next:'Следующий урок',pm:'Родительское собрание',notOn:'Ещё не на карте',
   notOnR:'Где этот кабинет, на карте пока нет',noMatch:'Ничего не найдено',tap:'Нажми на зону — покажу её кабинеты',
   clear:'Очистить',other:'Другое',rooms:'Кабинеты',noRooms:'Здесь нет кабинетов из расписания',mapL:'Карта школы',inset:'Отдельное здание'}
};
var st={sel:null,q:'',rooms:null,busy:false},CB={},LANG='he';
function tx(k){return (T[LANG]||T.he)[k]||T.he[k]||k;}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function L(o){return o?(o[LANG]||o.he):'';}
function zone(k){for(var i=0;i<Z.length;i++)if(Z[i].k===k)return Z[i];return null;}
function zoneOf(r){r=String(r||'').trim();for(var i=0;i<Z.length;i++)for(var j=0;j<Z[i].pre.length;j++)if(r.indexOf(Z[i].pre[j])===0)return Z[i];return null;}
function offOf(r){r=String(r||'').trim();for(var i=0;i<OFF.length;i++)if(r.indexOf(OFF[i][0])===0)return OFF[i];return null;}
function norm(s){return String(s||'').toLowerCase().replace(/["'׳״\-–—.,]/g,'').replace(/\s+/g,' ').trim();}
// «גפן 23 יא5» → «23 יא5» (корпус и так виден)
function short(r,z){var p=z?z.pre.filter(function(x){return r.indexOf(x)===0;})[0]:null;var s=p?r.slice(p.length).trim():r;return s||r;}
function load(){
  if(st.rooms||st.busy)return;st.busy=true;
  try{fetch(BASE+'teacher/rooms.json').then(function(r){if(!r.ok)throw 0;return r.json();}).then(function(d){
    st.rooms=Object.keys((d&&d.rooms)||{});st.busy=false;if(CB.shown&&CB.shown()&&CB.render)CB.render();
  }).catch(function(){st.busy=false;st.rooms=[];if(CB.shown&&CB.shown()&&CB.render)CB.render();});}catch(e){st.busy=false;st.rooms=[];}
}
function allRooms(extra){
  var seen={},out=[];(st.rooms||[]).concat(extra||[]).forEach(function(r){r=String(r||'').trim();if(r&&!seen[r]){seen[r]=1;out.push(r);}});
  return out.sort(function(a,b){return a.localeCompare(b,'he',{numeric:true});});
}
var css=
'.smap{margin:6px 0 18px}'+
'.smap-q{position:relative;margin:0 0 10px}'+
'.smap-q input{width:100%;box-sizing:border-box;min-height:46px;padding:12px 16px;border-radius:16px;border:1px solid #333;background:#1f1f1f;color:#f5f5f5;font:inherit;font-size:16px;outline:none}'+
'.smap-q input:focus{border-color:#C6FF00}'+
'.smap-res{display:flex;flex-direction:column;gap:6px;margin:0 0 10px}'+
'.smap-res[hidden],.smap-res [hidden],.smap-nm[hidden]{display:none}'+
'.smap-row{display:flex;align-items:center;gap:10px;width:100%;min-height:46px;padding:10px 14px;border-radius:14px;border:1px solid #2c2c2c;background:#202020;color:#f5f5f5;font:inherit;text-align:start;cursor:pointer}'+
'.smap-row .zl{margin-inline-start:auto;color:#9a9a9a;font-size:13px;white-space:nowrap}'+
'.smap-nm{color:#9a9a9a;font-size:14px;padding:4px 6px 10px}'+
'.smap-here{display:flex;flex-direction:column;gap:8px;margin:0 0 10px}'+
'.smap-here button{display:flex;flex-direction:column;align-items:flex-start;gap:2px;width:100%;min-height:52px;padding:10px 14px;border-radius:16px;border:1px solid #2c2c2c;border-inline-start:4px solid #C6FF00;background:#202020;color:#f5f5f5;font:inherit;text-align:start;cursor:pointer}'+
'.smap-here button.on{background:rgba(198,255,0,.1);border-color:#C6FF00}'+
'.smap-here .k{color:#C6FF00;font-size:12px;font-weight:700;letter-spacing:.02em}'+
'.smap-here .v{font-size:15px}'+
'.smap-svg{display:block;width:100%;height:auto;max-width:560px;margin:0 auto;background:#1b1b1b;border:1px solid #2a2a2a;border-radius:22px;touch-action:manipulation;-webkit-tap-highlight-color:transparent}'+
'.smap-svg .z{cursor:pointer;outline:none}'+
'.smap-svg .z polygon,.smap-svg .z rect{fill:#2a2a2a;stroke:#4a4a4a;stroke-width:3;stroke-linejoin:round;transition:fill .25s,stroke .25s}'+
'.smap-svg .z.in rect{stroke-dasharray:10 8}'+
'.smap-svg .z:focus-visible polygon,.smap-svg .z:focus-visible rect{stroke:#f5f5f5}'+
'.smap-svg .z.off polygon{fill:#232323;stroke:#3a3a3a}'+
'.smap-svg .z.on polygon,.smap-svg .z.on rect{fill:rgba(198,255,0,.24);stroke:#C6FF00;stroke-width:5}'+
'.smap-svg text{fill:#d6d6d6;font-size:27px;font-weight:700;text-anchor:middle;dominant-baseline:middle;pointer-events:none;font-family:inherit}'+
'.smap-svg text.n{fill:#7d7d7d;font-size:17px;font-weight:600}'+
'.smap-svg .z.on text{fill:#C6FF00}'+
'.smap-svg .pin{fill:#C6FF00;pointer-events:none}'+
'.smap-svg .ring{fill:none;stroke:#C6FF00;stroke-width:4;pointer-events:none;transform-box:fill-box;transform-origin:center;animation:smapPulse 1.6s ease-out infinite}'+
'@keyframes smapPulse{0%{transform:scale(.4);opacity:1}100%{transform:scale(2.2);opacity:0}}'+
'@media (prefers-reduced-motion:reduce){.smap-svg .ring{animation:none;opacity:.6}.smap-svg .z polygon,.smap-svg .z rect{transition:none}}'+
'.smap-tip{color:#8a8a8a;font-size:13px;text-align:center;margin:8px 0 0}'+
'.smap-info{margin:12px 0 0;padding:14px 16px;border-radius:18px;background:#202020;border:1px solid #2c2c2c}'+
'.smap-info h3{margin:0 0 2px;font-size:18px;color:#f5f5f5}'+
'.smap-info h3 .r{color:#C6FF00}'+
'.smap-info p{margin:2px 0 0;color:#a5a5a5;font-size:14px}'+
'.smap-chips{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 0}'+
'.smap-chip{min-height:40px;padding:8px 12px;border-radius:999px;border:1px solid #333;background:#262626;color:#eaeaea;font:inherit;font-size:14px;cursor:pointer}'+
'.smap-chip.on{border-color:#C6FF00;color:#C6FF00;background:rgba(198,255,0,.1)}'+
'.smap-off{margin:16px 0 0}'+
'.smap-off h4{margin:0 0 6px;color:#9a9a9a;font-size:13px;font-weight:600}'+
'.smap-off .b{margin:8px 0 0;color:#cfcfcf;font-size:14px;font-weight:600}'+
// кабинет в карточке урока: нажатие открывает карту
'[data-mact="go"]{cursor:pointer;text-decoration:underline dotted rgba(198,255,0,.55);text-decoration-thickness:2px;text-underline-offset:4px}';
function addCss(){if(document.getElementById('smap-css'))return;var s=document.createElement('style');s.id='smap-css';s.textContent=css;(document.head||document.documentElement).appendChild(s);}

function svg(selZ,pinZ){
  var h='<svg class="smap-svg" viewBox="110 0 940 880" role="group" aria-label="'+esc(tx('mapL'))+'">';
  Z.forEach(function(z){
    var on=selZ===z.k,name=L(z.nm)||L(z.lb);
    h+='<g class="z'+(on?' on':'')+(z.inset?' in':'')+(z.pre.length?'':' off')+'" data-mact="z" data-z="'+z.k+'" role="button" tabindex="0" aria-pressed="'+on+'" aria-label="'+esc(name)+'">';
    if(z.inset){var p=z.pts.split(' ').map(function(q){return q.split(',').map(Number);});
      h+='<rect x="'+p[0][0]+'" y="'+p[0][1]+'" width="'+(p[1][0]-p[0][0])+'" height="'+(p[2][1]-p[0][1])+'" rx="22"/>';}
    else h+='<polygon points="'+z.pts+'"/>';
    h+='<text x="'+z.x+'" y="'+z.y+'">'+esc(L(z.lb))+'</text>';
    h+='<text class="n" x="'+z.x+'" y="'+(z.y+30)+'">'+esc(z.inset?tx('inset'):'\u2066'+z.n+'\u2069')+'</text></g>';
  });
  var pz=zone(pinZ);
  if(pz)h+='<circle class="ring" cx="'+pz.x+'" cy="'+(pz.y-46)+'" r="16"/><path class="pin" d="M'+pz.x+' '+(pz.y-18)+'c-10-14-20-22-20-34a20 20 0 0 1 40 0c0 12-10 20-20 34z"/><circle cx="'+pz.x+'" cy="'+(pz.y-52)+'" r="7" fill="#171717" style="pointer-events:none"/>';
  return h+'</svg>';
}
// o: {lang, rooms:[ещё кабинеты], here:[{k:'now'|'next'|'pm', room, label}]}
function html(o){
  o=o||{};LANG=T[o.lang]?o.lang:'he';addCss();load();
  var here=(o.here||[]).filter(function(x){return x&&x.room;}),rooms=allRooms((o.rooms||[]).concat(here.map(function(x){return x.room;})));
  var sel=st.sel,selR=sel&&sel.r?sel.r:null,selZ=selR?(zoneOf(selR)||{}).k:sel&&sel.z?sel.z:null;
  var h='<div class="smap">';
  h+='<div class="smap-q"><input id="mapq" type="search" autocomplete="off" enterkeyhint="search" placeholder="'+esc(tx('search'))+'" aria-label="'+esc(tx('search'))+'" value="'+esc(st.q)+'"></div>';
  // результаты поиска: все кабинеты в разметке, видимые отбираются без перерисовки (клавиатура не прыгает)
  h+='<div class="smap-res" id="mapres"'+(st.q?'':' hidden')+'>';
  var qn=norm(st.q),shown=0;
  rooms.forEach(function(r){var z=zoneOf(r),f=offOf(r),ok=!!qn&&norm(r).indexOf(qn)>=0&&shown<12;if(ok)shown++;
    h+='<button class="smap-row" data-mact="r" data-r="'+esc(r)+'" data-key="'+esc(norm(r))+'"'+(ok?'':' hidden')+'><bdi>'+esc(r)+'</bdi><span class="zl">'+esc(z?L(z.nm)||L(z.lb):f?tx('notOn'):'')+'</span></button>';});
  h+='</div><div class="smap-nm" id="mapnm"'+(qn&&!shown?'':' hidden')+'>'+esc(tx('noMatch'))+'</div>';
  if(here.length){h+='<div class="smap-here">';
    here.forEach(function(x){h+='<button class="'+(selR===x.room?'on':'')+'" data-mact="r" data-r="'+esc(x.room)+'"><span class="k">'+esc(tx(x.k)||x.k)+'</span><span class="v"><bdi>'+esc(x.label||'')+'</bdi>'+(x.label?' · ':'')+'<bdi>'+esc(x.room)+'</bdi></span></button>';});
    h+='</div>';}
  h+=svg(selZ,selR?selZ:null);
  if(!sel)h+='<p class="smap-tip">'+esc(tx('tap'))+'</p>';
  if(selR){var z=zoneOf(selR);
    h+='<div class="smap-info"><h3><span class="r"><bdi>'+esc(selR)+'</bdi></span></h3>';
    h+=z?'<p>'+esc((L(z.nm)||L(z.lb))+(z.sub?' — '+L(z.sub):''))+'</p>':'<p>'+esc(tx('notOnR'))+'</p>';
    h+='</div>';}
  else if(selZ){var zz=zone(selZ),zr=rooms.filter(function(r){var q=zoneOf(r);return q&&q.k===selZ;});
    h+='<div class="smap-info"><h3>'+esc(L(zz.nm)||L(zz.lb))+'</h3>'+(zz.sub?'<p>'+esc(L(zz.sub))+'</p>':'');
    if(zr.length){h+='<div class="smap-chips">';zr.forEach(function(r){h+='<button class="smap-chip" data-mact="r" data-r="'+esc(r)+'"><bdi>'+esc(short(r,zz))+'</bdi></button>';});h+='</div>';}
    else if(zz.pre.length&&st.rooms)h+='<p>'+esc(tx('noRooms'))+'</p>';
    h+='</div>';}
  // корпуса, которых ещё нет на схеме
  var off={};rooms.forEach(function(r){if(zoneOf(r))return;var f=offOf(r),k=f?f[0]:'';(off[k]=off[k]||[]).push(r);});
  var keys=OFF.map(function(x){return x[0];}).filter(function(k){return off[k];});if(off[''])keys.push('');
  if(keys.length){h+='<div class="smap-off"><h4>'+esc(tx('notOn'))+'</h4>';
    keys.forEach(function(k){var f=offOf(k);h+='<div class="b">'+esc(k?L(f[1]):tx('other'))+'</div><div class="smap-chips">';
      off[k].forEach(function(r){h+='<button class="smap-chip'+(selR===r?' on':'')+'" data-mact="r" data-r="'+esc(r)+'"><bdi>'+esc(k?short(r,{pre:[k]}):r)+'</bdi></button>';});h+='</div>';});
    h+='</div>';}
  return h+'</div>';
}
function focusMap(root){try{var m=root.querySelector('.smap-svg');if(m&&m.getBoundingClientRect().top<0)m.scrollIntoView({block:'start',behavior:'smooth'});}catch(e){}}
// cb: {open() — показать экран карты, render() — перерисовать, shown() — карта сейчас на экране}
function bind(root,cb){
  CB=cb||{};addCss();
  var act=function(el,e){
    var a=el.getAttribute('data-mact');
    if(e){e.stopPropagation();if(a!=='go')e.preventDefault();}
    if(a==='go'){st.sel={r:el.getAttribute('data-r')};st.q='';if(CB.open)CB.open();return;}
    if(a==='z'){var k=el.getAttribute('data-z');st.sel=st.sel&&st.sel.z===k?null:{z:k};}
    else if(a==='r'){st.sel={r:el.getAttribute('data-r')};st.q='';}
    if(CB.render)CB.render();
    if(a==='r')focusMap(root);
  };
  // фаза захвата: нажатие на кабинет внутри карточки урока не доходит до обработчика самой карточки
  root.addEventListener('click',function(e){var el=e.target.closest&&e.target.closest('[data-mact]');if(el&&root.contains(el))act(el,e);},true);
  root.addEventListener('keydown',function(e){if(e.key!=='Enter'&&e.key!==' ')return;var el=e.target.closest&&e.target.closest('[data-mact]');if(el&&el.tagName!=='BUTTON')act(el,e);});
  root.addEventListener('input',function(e){if(!e.target||e.target.id!=='mapq')return;st.q=e.target.value;var q=norm(st.q),n=0;
    root.querySelectorAll('#mapres [data-key]').forEach(function(b){var ok=!!q&&b.getAttribute('data-key').indexOf(q)>=0&&n<12;b.hidden=!ok;if(ok)n++;});
    var res=document.getElementById('mapres'),nm=document.getElementById('mapnm');if(res)res.hidden=!q;if(nm)nm.hidden=!(q&&!n);});
}
// открыть карту с выбранным кабинетом (или без выбора)
function show(room){st.sel=room?{r:String(room)}:null;st.q='';}
// атрибуты для кабинета в карточке урока: нажатие открывает карту
function attr(room){return room?' data-mact="go" data-r="'+esc(room)+'" role="button" tabindex="0"':'';}
window.SkedyMap={html:html,bind:bind,show:show,attr:attr,zoneOf:function(r){var z=zoneOf(r);return z?z.k:null;},prefetch:load};
})();
