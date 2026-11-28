/* Карта школы — общая для приложения учеников, Skedy Teachers и Skedy Parents.
   Схема зон — по плану школы «שמות המתחמים» (обведено вручную, координаты в пикселях того плана).
   Приложение рисует свою шапку, а тело экрана берёт из SkedyMap.html(o); нажатия ловит SkedyMap.bind.
   Кабинеты — из teacher/rooms.json (все классы школы) + o.rooms. Корпус кабинета — по первым словам названия. */
(function(){
'use strict';
var BASE=(function(){try{var s=document.currentScript&&document.currentScript.src;return s?s.replace(/map\.js(\?.*)?$/,''):'/';}catch(e){return '/';}})();
// k — ключ, n — номер на плане школы, lb — подпись на схеме, nm — название, sub — пояснение, pre — с чего начинается название кабинета
var Z=[
 {k:'shaked',go:'s',kind:'mix',bld:['580,8 868,20 872,95 950,108 950,158 583,155'],n:'3',pre:['שקד'],lb:{he:'שקד',en:'Shaked',ru:'Шакед'},x:700,y:72,
  pts:'580,8 868,20 872,95 950,108 948,245 900,238 900,193 565,170'},
 {k:'sport',go:'spd',kind:'bld',ic:'🏀',n:'7',pre:['חנ"ג','מגרש'],lb:{he:'ספורט',en:'Sports',ru:'Спорт'},x:262,y:300,
  sub:{he:'מגרשי ספורט',en:'Sports fields',ru:'Спортивные площадки'},
  pts:'130,78 196,78 196,195 386,206 376,414 126,396'},
 // אולם ספורט — отдельное здание к северу от площадок (отметка автора на скриншоте, 11.2026)
 {k:'hall',go:'spn',kind:'bld',ic:'🏐',n:'',pre:['אולם ספורט'],lb:{he:'אולם ספורט',en:'Gym',ru:'Спортзал'},x:292,y:128,
  nm:{he:'אולם ספורט',en:'Sports hall (gym)',ru:'Спортивный зал'},
  pts:'198,74 386,74 386,204 198,194'},
 {k:'oren',go:'o',kind:'mix',bld:['387,132 436,135 434,300 387,300','505,228 552,232 550,402 505,400'],ic:'🌳',n:'10',pre:['אורן'],lb:{he:'אורן',en:'Oren',ru:'Орен'},x:470,y:176,
  sub:{he:'רחבת שכבת ז׳',en:'7th grade yard',ru:'Двор 7-х классов'},
  pts:'386,130 568,144 565,170 548,418 376,415 386,206'},
 {k:'rimon',go:'r',kind:'mix',bld:['566,234 636,234 636,440 562,440','636,210 664,210 664,246 636,246','846,234 894,236 894,398 846,398'],ic:'🌳',n:'8',pre:['רימון'],lb:{he:'רימון',en:'Rimon',ru:'Римон'},x:725,y:315,
  pts:'565,170 900,193 896,402 836,402 832,446 640,440 548,450 548,418'},
 {k:'erez',go:'e',kind:'mix',bld:['900,240 1028,244 1014,398 897,400'],ic:'💻',n:'4',pre:['ארז'],lb:{he:'ארז',en:'Erez',ru:'Эрез'},x:938,y:390,
  pts:'900,238 1028,242 992,532 832,532 836,402 896,402'},
 {k:'brosh',go:'b',kind:'yard',ic:'🌳',n:'6',pre:[],lb:{he:'ברוש',en:'Brosh',ru:'Брош'},x:572,y:520,
  pts:'376,415 548,418 548,450 640,440 630,575 500,578 492,610 372,592'},
 // здание ברוש (отметка автора на скриншоте, 11.2026): в западной части двора ברוש; в нём кабинеты ברוש 1–6 (ז7–ז10, ט1, ט9)
 {k:'z7',go:'zd',kind:'bld',ic:'🏫',n:'',pre:['ברוש'],lb:{he:'ברוש',en:'Brosh',ru:'Брош'},x:416,y:520,
  nm:{he:'בניין ברוש',en:'Brosh building',ru:'Корпус Брош'},sub:{he:'ברוש 1–6 (ז7–ז10, ט1, ט9)',en:'Brosh 1–6 (ז7–ז10, ט1, ט9)',ru:'ברוש 1–6 (ז7–ז10, ט1, ט9)'},
  pts:'372,462 468,462 468,586 372,586'},
 {k:'alon',go:'a',kind:'bld',ic:'🔬',n:'1–2',pre:['אלון'],lb:{he:'אלון',en:'Alon',ru:'Алон'},x:732,y:505,
  sub:{he:'קומת קרקע וקומה שנייה',en:'Ground floor and 2nd floor',ru:'Первый и второй этаж'},
  pts:'640,440 832,446 832,532 828,580 630,556'},
 {k:'audit',go:'au',kind:'yard',ic:'🎭',n:'9',pre:['אודיטוריום'],lb:{he:'אודיטוריום',en:'Auditorium',ru:'Аудиториум'},x:738,y:645,
  sub:{he:'רחבת אודיטוריום',en:'Auditorium yard',ru:'Площадь у аудиториума'},
  pts:'655,560 828,580 832,532 905,526 890,588 826,594 822,696 645,700'},
 {k:'gefen',go:'g',kind:'bld',ic:'🏫',n:'12',pre:['גפן'],lb:{he:'גפן',en:'Gefen',ru:'Гефен'},x:538,y:785,
  sub:{he:'תיכון · קומה 0 (תחתונה)',en:'High school · floor 0 (lower)',ru:'Старшая школа · этаж 0 (нижний)'},
  pts:'468,692 612,698 608,856 465,860'},
 {k:'tich',go:'t',kind:'bld',ic:'🏫',n:'13–14',pre:[],lb:{he:'תיכון',en:'High school',ru:'Старшая'},x:708,y:785,
  nm:{he:'תיכון · קומות 1–2',en:'High school · floors 1–2',ru:'Старшая школа · этажи 1–2'},
  sub:{he:'קומה 1 — קומת חדר המורים · קומה 2 — עליונה',en:'Floor 1 — teachers’ room · floor 2 — top',ru:'Этаж 1 — учительская · этаж 2 — верхний'},
  pts:'612,698 812,706 800,852 608,856'},
 {k:'yard',go:'y',kind:'yard',ic:'🌳',n:'11',pre:[],lb:{he:'רחבה',en:'Yard',ru:'Двор'},x:878,y:785,
  nm:{he:'רחבת תיכון ראשית',en:'Main high school yard',ru:'Главный двор старшей школы'},
  pts:'815,702 955,700 950,850 800,862'},
 // בית רינה на плане школы — отдельной вставкой: стоит не рядом с остальными корпусами
 {k:'rina',kind:'bld',ic:'🎨',n:'5',pre:['בית רינה'],lb:{he:'בית רינה',en:'Beit Rina',ru:'Бейт-Рина'},x:282,y:752,inset:true,
  sub:{he:'מבנה נפרד, מחוץ למתחם הראשי',en:'Separate building, outside the main campus',ru:'Отдельное здание, вне основной территории'},
  pts:'132,660 432,660 432,850 132,850'}
];
/* ---------- геопозиция и маршрут ---------- */
// Привязка плана к GPS: подобие (поворот, масштаб, сдвиг) по трём точкам автора из Google Maps
// (верхний угол зоны 7, верхний левый угол зоны 4, нижний левый угол зоны 12; ошибка ~1 м):
// E + iN = a·(x − i·y) + b, где E/N — метры к востоку/северу от (lat0, lon0), x/y — пиксели плана.
var GEO={lat0:32.1335419,lon0:34.8308384,k:94266.97,ar:0.19304037,ai:-0.02887301,br:-65.846323,bi:179.079785};
var MPX=Math.sqrt(GEO.ar*GEO.ar+GEO.ai*GEO.ai); // метров в пикселе плана (~0,195)
function toPlan(lat,lon){var zr=(lon-GEO.lon0)*GEO.k-GEO.br,zi=(lat-GEO.lat0)*111320-GEO.bi,d=GEO.ar*GEO.ar+GEO.ai*GEO.ai;
  return {x:(zr*GEO.ar+zi*GEO.ai)/d,y:-(zi*GEO.ar-zr*GEO.ai)/d};}
// дорожки и дворы — по спутниковому снимку плана (узлы в пикселях плана, только по открытым местам: дворы 6, 8, 9, 10, 11,
// низ зоны 4 с деревьями, полоса к югу от спортзала, площадка к северу от двора ז׳, проходы у ברוש; входы в корпуса — на их краях)
var NODE={
  spn:[290,60],nn:[440,68],nt:[470,150],o:[465,290],os:[465,410],spd:[368,412], // север, двор ז׳ (10), вход в спортзал — его угол со стороны двора
  b:[500,500],j6:[620,450],a1:[632,510],r1:[652,436],r:[750,330],s:[745,172],    // двор ברוש (6), проход в двор רימון (8), שקד
  e1:[845,420],e2:[880,495],e:[930,405],ae:[865,555],                            // низ ארז (4) с деревьями, вход в ארז
  jb:[640,590],a:[735,585],au:[740,630],q:[815,690],t:[720,697],                 // двор 9, אלון снизу, תיכון со двора 9
  sw:[485,655],p1:[610,676],g:[520,690],y:[875,780],ty:[805,760],ent:[962,778],ent3:[128,360],ent4:[126,591],wj:[380,605],wk:[474,604],zd:[476,520]};  // входы (со слов и отметок автора): ent — с улицы у רחבת תיכון, ent3 — у западной стены спортзала, ent4 — на западе над בית רינה; wj — развилка у ברוש               // проход вдоль ברוש к גפן, двор 11
var EDGE=[['spn','nn'],['nn','nt'],['nt','o'],['o','os'],['os','spd'],['os','b'],['b','j6'],['j6','r1'],['r1','r'],['r','s'],['r','e1'],
  ['e1','e2'],['e2','e'],['e2','ae'],['ae','au'],['b','a1'],['b','jb'],['jb','au'],['a','au'],['au','q'],['q','y'],['q','ty'],['y','ty'],['y','ent'],['ent3','spd'],['ent4','wj'],['wj','wk'],['wk','b'],['wk','sw'],['zd','b'],
  ['b','sw'],['sw','g'],['sw','p1'],['p1','au'],['p1','t'],['t','au']];
function dist(p,q){var dx=p[0]-q[0],dy=p[1]-q[1];return Math.sqrt(dx*dx+dy*dy);}
// кратчайший путь от точки (в пикселях) до узла цели: Дейкстра от цели, потом лучший узел для входа в сеть
function route(from,goal){
  var D={},prev={},left={},k;for(k in NODE){D[k]=Infinity;left[k]=1;}D[goal]=0;
  for(;;){var u=null;for(k in left)if(u===null||D[k]<D[u])u=k;if(u===null||D[u]===Infinity)break;delete left[u];
    EDGE.forEach(function(e){var v=e[0]===u?e[1]:e[1]===u?e[0]:null;if(!v||!left[v])return;var c=D[u]+dist(NODE[u],NODE[v]);if(c<D[v]){D[v]=c;prev[v]=u;}});}
  // входим в сеть только через 2 ближайших узла (иначе прямая к цели всегда короче — линия шла бы сквозь здания)
  var near=Object.keys(NODE).sort(function(x,y){return dist(from,NODE[x])-dist(from,NODE[y]);}).slice(0,2);
  var best=null,bc=Infinity;near.forEach(function(q){var c=dist(from,NODE[q])+D[q];if(c<bc){bc=c;best=q;}});
  if(!best)return null;var pts=[from],n=best;while(n){pts.push(NODE[n]);n=prev[n];}
  return {pts:pts,m:bc*MPX};
}
// корпуса, которых ещё нет на схеме (их кабинеты — списком «ещё не на карте»)
var OFF=[['זית',{he:'זית',en:'Zayit',ru:'Заит'}],['ריושקה',{he:'ריושקה',en:'Ryushka',ru:'Рюшка'}],['תמר',{he:'תמר',en:'Tamar',ru:'Тамар'}]];
var T={
 he:{search:'חיפוש כיתה, מעבדה…',now:'עכשיו',next:'השיעור הבא',pm:'אסיפת הורים',notOn:'עוד לא על המפה',
   notOnR:'המיקום של הכיתה הזו עוד לא על המפה',noMatch:'לא נמצא',tap:'נגיעה באזור מראה את הכיתות שבו',
   clear:'ניקוי',other:'אחר',rooms:'כיתות',noRooms:'אין כאן כיתות מהמערכת',mapL:'מפת בית הספר',inset:'מבנה נפרד',
   geoBtn:'איפה אני? מסלול',geoOff:'הסתרת המיקום',geoWait:'מחפשים את המיקום…',geoDenied:'אין גישה למיקום. אפשר לאשר בהגדרות הטלפון.',geoErr:'לא הצלחנו לקבל מיקום',geoNo:'הטלפון לא תומך במיקום',
   geoFar:'מחוץ לשטח בית הספר · עוד כ־{d}',geoRoute:'{t} דק׳ הליכה · {d}',geoPick:'בחרו כיתה או אזור — ונראה את הדרך',geoInacc:'ה־GPS לא מדויק (±{d})',geoNoRoute:'לאזור הזה אין מסלול על המפה',
   geoPriv:'המיקום נשאר בטלפון ולא נשלח לשום מקום.',gate:'כניסה',flGround:'קומת קרקע',flUp:'קומה עליונה',flDown:'קומה ‎-1 (מרתף)',geoFromGate:'מהכניסה: {t} דק׳ הליכה · {d}',geoIos:'כדי שהאייפון לא ישאל כל פעם: הגדרות ← Safari ← מיקום ← „אפשר“.',m:'מ׳',km:'ק״מ',zin:'הגדלה',zout:'הקטנה',zreset:'כל המפה',full:'מסך מלא',fullX:'סגירת מסך מלא'},
 en:{search:'Search a room, lab…',now:'Now',next:'Next lesson',pm:'Parents’ meeting',notOn:'Not on the map yet',
   notOnR:'This room’s location isn’t on the map yet',noMatch:'Nothing found',tap:'Tap an area to see its rooms',
   clear:'Clear',other:'Other',rooms:'Rooms',noRooms:'No timetable rooms here',mapL:'School map',inset:'Separate building',
   geoBtn:'Where am I? Route',geoOff:'Hide my location',geoWait:'Finding your location…',geoDenied:'No access to location. You can allow it in the phone settings.',geoErr:'Couldn’t get your location',geoNo:'This phone can’t share its location',
   geoFar:'Outside the school · about {d} away',geoRoute:'{t} min walk · {d}',geoPick:'Pick a room or area to see the way',geoInacc:'GPS is inaccurate (±{d})',geoNoRoute:'No route to this area on the map',
   geoPriv:'Your location stays on your phone and is never sent anywhere.',gate:'Entrance',flGround:'ground floor',flUp:'upper floor',flDown:'floor −1 (basement)',geoFromGate:'From the entrance: {t} min walk · {d}',geoIos:'So your iPhone doesn’t ask every time: Settings → Safari → Location → Allow.',m:'m',km:'km',zin:'Zoom in',zout:'Zoom out',zreset:'Whole map',full:'Full screen',fullX:'Close full screen'},
 ru:{search:'Поиск кабинета, лаборатории…',now:'Сейчас',next:'Следующий урок',pm:'Родительское собрание',notOn:'Ещё не на карте',
   notOnR:'Где этот кабинет, на карте пока нет',noMatch:'Ничего не найдено',tap:'Нажми на зону — покажу её кабинеты',
   clear:'Очистить',other:'Другое',rooms:'Кабинеты',noRooms:'Здесь нет кабинетов из расписания',mapL:'Карта школы',inset:'Отдельное здание',
   geoBtn:'Где я? Маршрут',geoOff:'Скрыть моё место',geoWait:'Ищу, где ты…',geoDenied:'Нет доступа к геопозиции. Её можно разрешить в настройках телефона.',geoErr:'Не удалось узнать, где ты',geoNo:'Телефон не умеет сообщать геопозицию',
   geoFar:'Ты не в школе · до неё примерно {d}',geoRoute:'{t} мин пешком · {d}',geoPick:'Выбери кабинет или зону — покажу дорогу',geoInacc:'GPS неточный (±{d})',geoNoRoute:'До этой зоны маршрута на карте нет',
   geoPriv:'Геопозиция остаётся в телефоне и никуда не отправляется.',gate:'Вход',flGround:'первый этаж',flUp:'второй этаж',flDown:'−1 этаж (подвал)',geoFromGate:'От входа: {t} мин пешком · {d}',geoIos:'Чтобы iPhone не спрашивал каждый раз: Настройки → Safari → Геопозиция → «Разрешить».',m:'м',km:'км',zin:'Крупнее',zout:'Мельче',zreset:'Вся карта',full:'Во весь экран',fullX:'Закрыть весь экран'}
};
var st={sel:null,q:'',rooms:null,busy:false,geo:null,watch:null},CB={},LANG='he';
function tx(k){return (T[LANG]||T.he)[k]||T.he[k]||k;}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function L(o){return o?(o[LANG]||o.he):'';}
function zone(k){for(var i=0;i<Z.length;i++)if(Z[i].k===k)return Z[i];return null;}
// где именно кабинет внутри корпуса (по видео и словам автора, 11.2026). שקד: холл со столом — у шоссе; два коридора
// первого этажа идут от холла к стоянке. Ближний к центру школы (к двору רימון): кабинеты руководства, ח5 = שקד 3,
// מנהל שכבה ח׳, в дальнем конце у стоянки ח9 = שקד 2 и выход «יציאה», обратно к холлу — ח10 = שקד 1.
// Ближний к дороге: от холла ח7 = שקד 6, ח1 = שקד 5, «קבוצות לימוד», ח3 = שקד 9, ח4 = שקד 10, ח6 = שקד 8, ח2 = שקד 7,
// у выхода ח8 = שקד 4. Где שקד 12/13 (הקבצה) — неизвестно, они только в корпусе
var SPOTS={'שקד 1':[890,140],'שקד 2':[742,130],'שקד 3':[794,116],
  // רימון (видео 6 и 7, слова автора): всё в западном корпусе, два этажа — внизу открытая галерея во двор 1→4
  // с севера на юг, после 4 лестница наверх, там закрытый коридор 5→8 с юга на север
  // ז׳ (фото автора «שכבה ז׳ – מיקום כיתות», снято с северного конца двора אורן на юг): восточный ряд — אורן 40 (ז6), 41 (ז4),
  // 42 (ז1), 43 (ז2) с севера на юг; западный ряд — אורן 47 (ז3), 46 (ז5); ברוש 1–4 — в здании ברוש у двора (1, 2 — первый этаж, 3, 4 — второй)
  'אורן 40':[508,250],'אורן 41':[508,292],'אורן 42':[508,334],'אורן 43':[508,376],'אורן 47':[434,224],'אורן 46':[434,270],
  // по фото: ברוש 1, 2 — первый этаж, ברוש 3, 4 — второй (ярлыки выше); 4 над 1, 3 над 2
  'ברוש 1':[458,500],'ברוש 2':[458,540],'ברוש 4':[430,500],'ברוש 3':[430,540],
  // אלון (видео 8 и 9 и слова автора): коридор посередине корпуса; южная сторона (к אודיטוריום) — 1 (י9), 2 (י8), 3 (חדר הקבצות),
  // 4 (י4); северная (к רימון/שקד) — 6 (י6), 7 (י10), 8 (מעבדה); второй этаж (видео 10): лаборатории биологии 10, 11,
  // צוות מדעים, אודיטוריום קטן, лаборатория физики 13, в конце 15 (הקבצה)
  'אלון 1':[664,552],'אלון 2':[696,555],'אלון 3':[728,558],'אלון 4':[760,561],'אלון 6':[700,462],'אלון 7':[740,463],'אלון 8':[780,464],'אלון 10':[650,505],'אלון 11':[676,507],'אלון 13':[800,512],'אלון 15':[826,514],
  // ארז (видео 11): −1 этаж, вход по лестнице вниз со двора — מחשבים 1 и 2
  'ארז 1':[944,300],'ארז 2':[974,300],
  // ארז, первый этаж (видео 12, наклейки над дверями): по коридору от входа — 3 (מחשבים), 4 (מחשבים), в конце у стеклянной двери 7 (הקבצה)
  'ארז 3':[924,352],'ארז 4':[952,352],'ארז 7':[998,352],
  // ארז, второй этаж (видео 13, 14): кабинет עובדת סוציאלית, 9 (אלקטרוניקה), 11 (הקבצה), 5 (אלקטרוניקה)
  'ארז 9':[948,262],'ארז 11':[974,262],'ארז 5':[922,262],
  'רימון 1':[620,270],'רימון 2':[620,320],'רימון 3':[620,370],'רימון 4':[620,420],
  'רימון 5':[588,420],'רימון 6':[588,370],'רימון 7':[588,320],'רימון 8':[588,270],
  'שקד 6':[828,34],'שקד 5':[796,33],'שקד 9':[736,32],'שקד 10':[712,32],'שקד 8':[678,31],'שקד 7':[652,30],'שקד 4':[598,30]};
// кабинеты руководства (только должности, без имён): '@ключ' — как кабинет в поиске и выборе
var PLACES=[
 {k:'@mgr',z:'shaked',xy:[924,118],t:{he:'מנהל/ת חטיבת הביניים',en:'Middle school principal',ru:'Директор средней школы (חטיבת הביניים)'}},
 {k:'@dep',z:'shaked',xy:[902,118],t:{he:'סגנ/ית מנהל/ת חטיבת הביניים',en:'Deputy principal, middle school',ru:'Заместитель директора средней школы'}},
 {k:'@cns8',z:'shaked',xy:[866,116],t:{he:'יועצת חינוכית שכבה ח׳',en:'School counselor, grade 8 (ח׳)',ru:'Школьный консультант (יועצת), параллель ח׳'}},
 {k:'@sped',z:'shaked',xy:[840,116],t:{he:'רכזת ויועצת חינוך מיוחד',en:'Special education coordinator',ru:'Координатор специального образования'}},
 {k:'@grp',z:'shaked',xy:[764,32],t:{he:'קבוצות לימוד',en:'Study groups room',ru:'Кабинет учебных групп (קבוצות לימוד)'}},
 {k:'@sw',z:'erez',xy:[1000,262],fl:1,t:{he:'עובדת סוציאלית',en:'Social worker',ru:'Социальный работник'}},
 {k:'@gr8',z:'shaked',xy:[760,116],t:{he:'מנהל/ת שכבה ח׳',en:'Grade 8 (ח׳) coordinator',ru:'Руководитель параллели ח׳'}}];
// этаж кабинета, если он не на первом: 1 — верхний этаж (кружок пунктиром), -1 — подвал (кружок точками), 0 — первый
var FLOOR={'ארז 5':1,'ארז 9':1,'ארז 11':1,'ארז 3':0,'ארז 4':0,'ארז 7':0,'ארז 1':-1,'ארז 2':-1,'אלון 10':1,'אלון 11':1,'אלון 13':1,'אלון 15':1,'ברוש 1':0,'ברוש 2':0,'ברוש 3':1,'ברוש 4':1,'רימון 1':0,'רימון 2':0,'רימון 3':0,'רימון 4':0,'רימון 5':1,'רימון 6':1,'רימון 7':1,'רימון 8':1};
function floorOf(r){var pl=placeOf(r);if(pl)return pl.fl!=null?pl.fl:null;var k=String(r||'').trim().split(/\s+/).slice(0,2).join(' ');return k in FLOOR?FLOOR[k]:null;}
function placeOf(r){for(var i=0;i<PLACES.length;i++)if(PLACES[i].k===r)return PLACES[i];return null;}
function spotOf(r){var p=placeOf(r);if(p)return p.xy;return SPOTS[String(r||'').trim().split(/\s+/).slice(0,2).join(' ')]||null;}  // «שקד 1 ח10 שמע» → «שקד 1»
function rName(r){var p=placeOf(r);return p?L(p.t):r;}
function zoneOf(r){var pl=placeOf(r);if(pl)return zone(pl.z);r=String(r||'').trim();for(var i=0;i<Z.length;i++)for(var j=0;j<Z[i].pre.length;j++)if(r.indexOf(Z[i].pre[j])===0)return Z[i];return null;}
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
'.smap-box{position:relative;max-width:720px;margin:0 auto}'+
// на телефоне схема — во всю ширину экрана, без полей
'@media (max-width:600px){.smap-box:not(.full){margin-inline:calc(50% - 50vw)}.smap-box:not(.full) .smap-svg{border-radius:0;border-inline:0}}'+
'.smap-svg{display:block;width:100%;height:auto;background:#24231d;border:1px solid #2a2a2a;border-radius:22px;touch-action:pan-y;-webkit-tap-highlight-color:transparent;user-select:none;-webkit-user-select:none}'+
'.smap-svg.zm{touch-action:none}'+
// во весь экран: поверх всего приложения
'.smap-box.full{position:fixed;inset:0;z-index:2147483000;max-width:none;margin:0;background:#141414;display:flex;flex-direction:column;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}'+
'.smap-box.full .smap-svg{flex:1;min-height:0;height:100%;border:0;border-radius:0;touch-action:none}'+
'.smap-box.full .smap-gline{position:absolute;top:calc(env(safe-area-inset-top) + 10px);inset-inline:64px;background:rgba(20,20,20,.9);border-radius:14px;padding:9px 12px;z-index:2}'+
'.smap-box.full .smap-zb{top:auto;right:auto;inset-inline-end:12px;bottom:calc(env(safe-area-inset-bottom) + 14px)}'+
'.smap-x{position:absolute;top:calc(env(safe-area-inset-top) + 8px);inset-inline-start:10px;z-index:3;width:44px;height:44px;border-radius:14px;border:1px solid #3a3a3a;background:rgba(30,30,30,.92);color:#f0f0f0;font:inherit;font-size:20px;cursor:pointer}'+
'.smap-svg .z{cursor:pointer;outline:none}'+
// «как со спутника»: крыши с панелями, плитка дворов, кроны деревьев, улицы
'.smap-svg .rf{stroke:#1b1d20;stroke-width:2;stroke-linejoin:round}'+
'.smap-svg .pv{stroke:none}'+
'.smap-svg .sh{fill:#000;opacity:.45}'+
'.smap-svg .tint{fill:transparent;stroke:none;transition:fill .25s}'+
'.smap-svg .ol{fill:none;stroke:rgba(255,255,255,.28);stroke-width:2.5;stroke-dasharray:8 7;stroke-linejoin:round;transition:stroke .25s}'+
'.smap-svg .z.in .ol{stroke:rgba(255,255,255,.45)}'+
'.smap-svg .z:focus-visible .ol{stroke:#f5f5f5;stroke-dasharray:none}'+
'.smap-svg .z.on .tint{fill:rgba(198,255,0,.26)}'+
'.smap-svg .z.on .ol{stroke:#C6FF00;stroke-width:5;stroke-dasharray:none}'+
'.smap-svg .road{fill:#3d3f42}'+
'.smap-svg .lane{fill:none;stroke:#cfcfcf;stroke-width:2.5;stroke-dasharray:16 14;opacity:.55}'+
'.smap-svg .park{fill:#4a4b4d}'+
'.smap-svg .walk{fill:none;stroke:#8a877f;stroke-width:12;stroke-linecap:round;opacity:.7;pointer-events:none}'+
'.smap-svg .trees{pointer-events:none}'+
'.smap-svg .spots circle.up{stroke-dasharray:4 3;fill:#2a2a2a}.smap-svg .spots circle.dn{stroke-dasharray:1.5 3;stroke-linecap:round;fill:#0e0e0e}.smap-svg .spots{pointer-events:none}.smap-svg .spots circle{fill:#171717;stroke:#f0f0f0;stroke-width:2.5}.smap-svg .spots circle.pl{fill:#f0f0f0;stroke:#171717}.smap-svg text.sn{font-size:14px;stroke:none;fill:#f0f0f0}'+
'.smap-svg .gate{pointer-events:none}.smap-svg .gate line{stroke:#C6FF00;stroke-width:4;stroke-dasharray:4 6;stroke-linecap:round}.smap-svg .gate circle{fill:#171717;stroke:#C6FF00;stroke-width:4}'+
'.smap-svg text.gi{font-size:22px;stroke:none}.smap-svg text.gt{fill:#C6FF00;font-size:18px;stroke-width:5px}'+
'.smap-svg .path{fill:none;stroke:#c9bd9f;stroke-width:9;stroke-linecap:round;stroke-linejoin:round;opacity:.38;pointer-events:none}'+
'.smap-svg text{fill:#fff;font-size:32px;font-weight:800;text-anchor:middle;dominant-baseline:middle;pointer-events:none;font-family:inherit;paint-order:stroke;stroke:#111;stroke-width:8px;stroke-linejoin:round}'+
'.smap-svg text.n{fill:#c4c4c4;font-size:19px;font-weight:700;stroke-width:6px}'+
'.smap-svg text.ic{font-size:30px;stroke:none}'+
'.smap-svg text.on{fill:#C6FF00}'+
'.smap-zb{position:absolute;right:8px;top:8px;display:flex;flex-direction:column;gap:6px;z-index:2}'+
'.smap-zb button{width:44px;height:44px;border-radius:14px;border:1px solid #3a3a3a;background:rgba(30,30,30,.92);color:#f0f0f0;font:inherit;font-size:22px;font-weight:700;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center}'+
'.smap-zb button:disabled{opacity:.35;cursor:default}'+
'.smap-svg .pin{fill:#C6FF00;pointer-events:none}'+
'.smap-svg .ring{fill:none;stroke:#C6FF00;stroke-width:4;pointer-events:none;transform-box:fill-box;transform-origin:center;animation:smapPulse 1.6s ease-out infinite}'+
'@keyframes smapPulse{0%{transform:scale(.4);opacity:1}100%{transform:scale(2.2);opacity:0}}'+
'@media (prefers-reduced-motion:reduce){.smap-svg .ring{animation:none;opacity:.6}.smap-svg .ol,.smap-svg .tint{transition:none}}'+
'.smap-geo{display:flex;flex-direction:column;align-items:stretch;gap:6px;margin:0 0 10px}'+
'.smap-me{min-height:46px;padding:10px 16px;border-radius:16px;border:1px solid #C6FF00;background:transparent;color:#C6FF00;font:inherit;font-size:15px;font-weight:600;cursor:pointer}'+
'.smap-me.on{background:#C6FF00;color:#171717}'+
'.smap-gline{color:#d6d6d6;font-size:14px;text-align:center;min-height:1.3em}'+
'.smap-gline:empty{display:none}'+
'.smap-gline b{color:#C6FF00}'+
'.smap-priv{color:#7d7d7d;font-size:12px;text-align:center;margin:6px 0 0}'+
'.smap-svg .rt{fill:none;stroke:#C6FF00;stroke-width:8;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:2 16;animation:smapDash 1s linear infinite}'+
'.smap-svg .rtb{fill:none;stroke:#171717;stroke-width:14;stroke-linecap:round;stroke-linejoin:round;opacity:.7}'+
'@keyframes smapDash{to{stroke-dashoffset:-18}}'+
'.smap-svg .acc{fill:rgba(77,163,255,.16);stroke:rgba(77,163,255,.5);stroke-width:2}'+
'.smap-svg .me{fill:#4da3ff;stroke:#fff;stroke-width:5}'+
'@media (prefers-reduced-motion:reduce){.smap-svg .rt{animation:none}}'+
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

function fmtD(m){return m>=1000?(Math.round(m/100)/10)+' '+tx('km'):Math.max(5,Math.round(m/5)*5)+' '+tx('m');}
// где я на плане и маршрут до выбранной зоны
function geoState(selZ){
  var g=st.geo;if(!g||g.lat==null)return null;var p=toPlan(g.lat,g.lon),r={p:p,acc:g.acc||0};
  // за пределами схемы — точку не рисуем, говорим, сколько до школы
  var dx=Math.max(110-p.x,0,p.x-1050),dy=Math.max(0-p.y,0,p.y-880);if(dx||dy){r.far=Math.sqrt(dx*dx+dy*dy)*MPX;}
  // не в школе — маршрут от ближайшего входа
  var gt=GATES.slice().sort(function(a,b){return dist([p.x,p.y],NODE[a.n])-dist([p.x,p.y],NODE[b.n]);})[0],z=zone(selZ),from=r.far!=null?NODE[gt.n]:[p.x,p.y];
  if(z&&z.go){r.rt=route(from,z.go);var sp=st.sel&&st.sel.r?spotOf(st.sel.r):null;if(r.rt&&sp){var lst=r.rt.pts[r.rt.pts.length-1];r.rt.pts.push(sp);r.rt.m+=dist(lst,sp)*MPX;}}else if(z)r.noRt=true;
  return r;
}
function geoSvg(selZ){
  var r=geoState(selZ);if(!r)return '';var h='';
  if(r.rt){var pts=r.rt.pts.map(function(q){return Math.round(q[0])+','+Math.round(q[1]);}).join(' ');h+='<polyline class="rtb" points="'+pts+'"/><polyline class="rt" points="'+pts+'"/>';}
  if(r.far!=null)return h;
  var ar=Math.min(r.acc/MPX,400);if(ar>14)h+='<circle class="acc" cx="'+r.p.x.toFixed(1)+'" cy="'+r.p.y.toFixed(1)+'" r="'+ar.toFixed(1)+'"/>';
  return h+'<circle class="me" cx="'+r.p.x.toFixed(1)+'" cy="'+r.p.y.toFixed(1)+'" r="13"/>';
}
function geoLine(selZ){
  var g=st.geo;if(st.watch==null&&!(g&&g.err))return '';
  if(!g)return esc(tx('geoWait'));if(g.err)return esc(tx(g.err));
  var r=geoState(selZ);if(!r)return esc(tx('geoWait'));
  if(r.far!=null)return esc(tx('geoFar').replace('{d}',fmtD(r.far)))+(r.rt?'<br><b>'+esc(tx('geoFromGate').replace('{t}',Math.max(1,Math.round(r.rt.m/75))).replace('{d}',fmtD(r.rt.m)))+'</b>':'');
  var h=r.rt?'<b>'+esc(tx('geoRoute').replace('{t}',Math.max(1,Math.round(r.rt.m/75))).replace('{d}',fmtD(r.rt.m)))+'</b>':esc(tx(r.noRt?'geoNoRoute':'geoPick'));
  if(r.acc>40)h+='<br><small>'+esc(tx('geoInacc').replace('{d}',fmtD(r.acc)))+'</small>';
  return h;
}
function curZ(){var s=st.sel;return s&&s.r?(zoneOf(s.r)||{}).k:s&&s.z?s.z:null;}
// перерисовать только слой геопозиции и строку под кнопкой (без render(): не сбивает поиск и прокрутку)
function geoPaint(){
  if(CB.shown&&!CB.shown()){geoStop(false,true);return;}
  var l=document.getElementById('smap-geo'),t=document.getElementById('smap-gline'),z=curZ();
  if(l)l.innerHTML=geoSvg(z);if(t)t.innerHTML=geoLine(z);
}
// «Где я» включали — запоминаем (только в телефоне), чтобы потом не нажимать и не спрашивать снова
var GEO_KEY='skedyMap.geo';
function geoWant(v){try{if(v==null)return localStorage.getItem(GEO_KEY)==='1';localStorage.setItem(GEO_KEY,v?'1':'0');}catch(e){}return false;}
// при открытии карты: включали раньше и разрешение уже дано — включаем сами, без запроса;
// если браузер ещё спросил бы (или не умеет сказать) — ждём нажатия кнопки
function geoAuto(){
  if(st.watch!=null||(st.geo&&st.geo.err)||!geoWant()||!navigator.geolocation||!navigator.permissions||!navigator.permissions.query)return;
  try{navigator.permissions.query({name:'geolocation'}).then(function(r){
    if(r&&r.state==='granted'&&st.watch==null&&(!CB.shown||CB.shown())){geoStart();if(CB.render)CB.render();}}).catch(function(){});}catch(e){}
}
function isIOS(){var u=navigator.userAgent||'';return /iphone|ipad|ipod/i.test(u)||(/macintosh/i.test(u)&&navigator.maxTouchPoints>1);}
// геопозиция — только по нажатию кнопки (или сама, если уже разрешена), только в телефоне: никуда не отправляется
function geoStart(){
  if(!navigator.geolocation){st.geo={err:'geoNo'};return;}
  st.geo=null;
  try{st.watch=navigator.geolocation.watchPosition(function(p){st.geo={lat:p.coords.latitude,lon:p.coords.longitude,acc:p.coords.accuracy};if(!geoWant())geoWant(true);geoPaint();},
    function(e){st.geo={err:e&&e.code===1?'geoDenied':'geoErr'};if(e&&e.code===1)geoStop(true);geoPaint();},
    {enableHighAccuracy:true,maximumAge:5000,timeout:20000});}catch(e){st.geo={err:'geoErr'};}
}
// keep — оставить ошибку на экране; away — ушли с карты (выбор «включено» помним)
function geoStop(keep,away){if(st.watch!=null){try{navigator.geolocation.clearWatch(st.watch);}catch(e){}}st.watch=null;if(!keep)st.geo=null;if(!keep&&!away)geoWant(false);}
// здания вне зон (по спутнику; серые, без подписи): между ברוש и גפן, между двором 9 и двором 11, на севере у края
var EXTRA=['522,574 648,577 646,656 520,654','832,616 920,618 918,700 832,700','295,8 487,8 487,42 295,42'];
var GATES=[{n:'ent',x:1012,y:778},{n:'ent3',x:150,y:340},{n:'ent4',x:150,y:575}];
var WALK=[]; // тротуары снаружи школы (рисуются, маршрут по ним не строится); сейчас нет
var VB0={x:110,y:0,w:940,h:880};
// улицы и стоянка (по спутнику): улица с востока, шоссе на северо-востоке, стоянка к северу от שקד
var ROADS=['1000,250 1060,236 1060,890 986,890 990,600','830,-10 935,-10 1060,130 1060,250 1000,250 952,120'];
var LANES=['M1025,250 L1022,890','M880,-10 L1060,190'],PARK=['492,0 576,0 576,138 492,138'];
function P(q){return q.split(' ').map(function(x){return x.split(',').map(Number);});}
function pip(x,y,p){var c=false;for(var i=0,j=p.length-1;i<p.length;j=i++){var a=p[i],b=p[j];if((a[1]>y)!==(b[1]>y)&&x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0])c=!c;}return c;}
function areaOf(p){var a=0;for(var i=0,j=p.length-1;i<p.length;j=i++)a+=(p[j][0]+p[i][0])*(p[j][1]-p[i][1]);return Math.abs(a/2);}
function bbox(p){var b={x0:1e9,y0:1e9,x1:-1e9,y1:-1e9};p.forEach(function(q){b.x0=Math.min(b.x0,q[0]);b.y0=Math.min(b.y0,q[1]);b.x1=Math.max(b.x1,q[0]);b.y1=Math.max(b.y1,q[1]);});return b;}
function rng(seed){var s=seed>>>0||1;return function(){s=(Math.imul(s,1103515245)+12345)>>>0;return (s>>>8)/16777216;};}
// крыша: у спортзала — светлая с решёткой, у остальных — солнечные панели вдоль длинной стороны
function roof(q,z){var b=bbox(P(q));return z&&(z.k==='sport'||z.k==='hall')?'url(#smapHall)':(b.y1-b.y0)>(b.x1-b.x0)*1.4?'url(#smapPanelV)':'url(#smapPanel)';}
// деревья: кроны в дворах (гуще во дворах с деревьями на снимке) и редкие вокруг школы; один раз, всегда одинаково
var DENS={rimon:1500,audit:1400,brosh:1600,oren:2000,erez:1400,shaked:1900,yard:3200};
var TREES=null;
function treesSvg(){
  if(TREES)return TREES;var out=[],blocked=[];
  Z.forEach(function(z){if(z.inset){var r=rectOf(z);blocked.push([[r.x-10,r.y-10],[r.x+r.w+10,r.y-10],[r.x+r.w+10,r.y+r.h+10],[r.x-10,r.y+r.h+10]]);}else blocked.push(P(z.pts));});EXTRA.concat(ROADS,PARK).forEach(function(q){blocked.push(P(q));});
  var tree=function(x,y,r){out.push('<circle cx="'+(x+4).toFixed(0)+'" cy="'+(y+6).toFixed(0)+'" r="'+r.toFixed(0)+'" fill="#000" opacity=".4"/><circle cx="'+x.toFixed(0)+'" cy="'+y.toFixed(0)+'" r="'+r.toFixed(0)+'" fill="url(#smapCanopy)"/>');};
  var bz=Z.filter(function(z){return z.kind==='bld'&&!z.inset;}).map(function(z){return P(z.pts);});
  Z.forEach(function(z,zi){var d=DENS[z.k];if(!d)return;var p=P(z.pts),bl=(z.bld||[]).map(P).concat(bz),b=bbox(p),n=Math.round(areaOf(p)/d),R=rng(zi*7919+13),tries=0;
    while(n>0&&tries<n*40){tries++;var x=b.x0+R()*(b.x1-b.x0),y=b.y0+R()*(b.y1-b.y0);
      if(!pip(x,y,p)||bl.some(function(q){return pip(x,y,q);}))continue;tree(x,y,11+R()*12);n--;}});
  var R=rng(4242),n=70,tries=0;
  while(n>0&&tries<4000){tries++;var x=VB0.x+R()*VB0.w,y=VB0.y+R()*VB0.h;if(blocked.some(function(q){return pip(x,y,q);}))continue;tree(x,y,10+R()*14);n--;}
  return TREES='<g class="trees">'+out.join('')+'</g>';
}
// вид: на телефоне во весь экран окно схемы вытянуто (st.asp = высота/ширина), иначе — как план
function asp(){return st.asp||VB0.h/VB0.w;}
function vbMax(){var a=asp(),w=Math.min(VB0.w,VB0.h/a);return {w:w,h:w*a};}
function vbDef(){var m=vbMax();return {x:VB0.x+(VB0.w-m.w)/2,y:VB0.y+(VB0.h-m.h)/2,w:m.w,h:m.h};}
function curVb(){return st.vb||vbDef();}
function vbStr(){var v=curVb();return v.x.toFixed(1)+' '+v.y.toFixed(1)+' '+v.w.toFixed(1)+' '+v.h.toFixed(1);}
function zoomed(){return !!st.vb&&st.vb.w<vbMax().w-1;}
function poly(pts,cls,fill){return '<polygon class="'+cls+'" points="'+pts+'"'+(fill?' fill="'+fill+'"':'')+'/>';}
function shadow(pts){return '<polygon class="sh" points="'+pts+'" transform="translate(7 9)"/>';}
function rectOf(z){var p=P(z.pts);return {x:p[0][0],y:p[0][1],w:p[1][0]-p[0][0],h:p[2][1]-p[0][1]};}
var DEFS='<defs>'+
  '<pattern id="smapSoil" width="64" height="64" patternUnits="userSpaceOnUse"><rect width="64" height="64" fill="#2d2c24"/><circle cx="10" cy="14" r="3" fill="#343227"/><circle cx="44" cy="38" r="4" fill="#28271f"/><circle cx="52" cy="8" r="2" fill="#37352a"/><circle cx="22" cy="50" r="2.5" fill="#323026"/></pattern>'+
  '<pattern id="smapPave" width="26" height="26" patternUnits="userSpaceOnUse"><rect width="26" height="26" fill="#5b554a"/><path d="M0 .5H26M.5 0V26" stroke="#4e493f" stroke-width="1.2"/></pattern>'+
  '<pattern id="smapPanel" width="38" height="22" patternUnits="userSpaceOnUse"><rect width="38" height="22" fill="#767b83"/><rect x="1.5" y="2" width="35" height="15" fill="#2b3d57"/><path d="M1.5 9.5H36.5M13 2V17M25 2V17" stroke="#3d5375" stroke-width="1"/></pattern>'+
  '<pattern id="smapPanelV" width="38" height="22" patternUnits="userSpaceOnUse" patternTransform="rotate(90)"><rect width="38" height="22" fill="#767b83"/><rect x="1.5" y="2" width="35" height="15" fill="#2b3d57"/><path d="M1.5 9.5H36.5M13 2V17M25 2V17" stroke="#3d5375" stroke-width="1"/></pattern>'+
  '<pattern id="smapHall" width="54" height="54" patternUnits="userSpaceOnUse"><rect width="54" height="54" fill="#9a9da2"/><path d="M0 .5H54M.5 0V54" stroke="#888b90" stroke-width="1.5"/><circle cx="27" cy="27" r="2.5" fill="#76797e"/></pattern>'+
  '<radialGradient id="smapCanopy" cx="38%" cy="34%" r="70%"><stop offset="0" stop-color="#5a9440"/><stop offset=".55" stop-color="#346327"/><stop offset="1" stop-color="#1f4017"/></radialGradient>'+
  '</defs>';
function svg(selZ,pinZ){
  var h='<svg class="smap-svg'+(zoomed()||st.full?' zm':'')+'" viewBox="'+vbStr()+'" role="group" aria-label="'+esc(tx('mapL'))+'">'+DEFS;
  // земля, улицы, стоянка, здания вне зон
  h+='<rect x="0" y="-60" width="1200" height="1000" fill="url(#smapSoil)"/>';
  ROADS.forEach(function(q){h+=poly(q,'road');});LANES.forEach(function(d){h+='<path class="lane" d="'+d+'"/>';});PARK.forEach(function(q){h+=poly(q,'park');});
  WALK.forEach(function(q){h+='<polyline class="walk" points="'+q+'"/>';});
  EXTRA.forEach(function(q){h+=shadow(q)+poly(q,'rf',roof(q));});
  // зоны: двор — плитка, здание — крыша; корпуса внутри; подсветка и пунктирный контур зоны
  Z.forEach(function(z){
    var on=selZ===z.k,name=L(z.nm)||L(z.lb);
    h+='<g class="z'+(on?' on':'')+(z.inset?' in':'')+'" data-mact="z" data-z="'+z.k+'" role="button" tabindex="0" aria-pressed="'+on+'" aria-label="'+esc(name)+'">';
    if(z.inset){var r=rectOf(z),rc=function(c,f,d){return '<rect class="'+c+'" x="'+(r.x+(d||0))+'" y="'+(r.y+(d?2+d:0))+'" width="'+r.w+'" height="'+r.h+'" rx="22"'+(f?' fill="'+f+'"':'')+'/>';};
      h+=rc('sh','',6)+rc('rf','url(#smapPanel)')+rc('tint')+rc('ol');}
    else if(z.kind==='bld')h+=shadow(z.pts)+poly(z.pts,'rf',roof(z.pts,z))+poly(z.pts,'tint')+poly(z.pts,'ol');
    else{h+=poly(z.pts,'pv','url(#smapPave)');(z.bld||[]).forEach(function(q){h+=shadow(q)+poly(q,'rf',roof(q));});h+=poly(z.pts,'tint')+poly(z.pts,'ol');}
    h+='</g>';
  });
  // дорожки, кроны деревьев (нажатие проходит сквозь них на зону), подписи
  h+='<g class="paths">';EDGE.forEach(function(e){var a=NODE[e[0]],b=NODE[e[1]];h+='<line class="path" x1="'+a[0]+'" y1="'+a[1]+'" x2="'+b[0]+'" y2="'+b[1]+'"/>';});h+='</g>';
  h+=treesSvg();
  Z.forEach(function(z){var on=selZ===z.k?' on':'';
    if(z.ic&&z.k!==pinZ)h+='<text class="ic" x="'+z.x+'" y="'+(z.y-36)+'">'+z.ic+'</text>';
    h+='<text class="'+on+'" x="'+z.x+'" y="'+z.y+'">'+esc(L(z.lb))+'</text>';
    h+='<text class="n'+on+'" x="'+z.x+'" y="'+(z.y+30)+'">'+esc(z.inset?tx('inset'):'⁦'+z.n+'⁩')+'</text>';});
  // входы: значки «🚪» (n — узел дорожек, x/y — где значок)
  GATES.forEach(function(g){var n=NODE[g.n];h+='<g class="gate"><line x1="'+n[0]+'" y1="'+n[1]+'" x2="'+g.x+'" y2="'+g.y+'"/><circle cx="'+g.x+'" cy="'+g.y+'" r="21"/><text class="gi" x="'+g.x+'" y="'+(g.y+1)+'">🚪</text><text class="gt" x="'+g.x+'" y="'+(g.y+38)+'">'+esc(tx('gate'))+'</text></g>';});
  // точки известных кабинетов внутри корпусов: номер класса или «•» у кабинета руководства
  // номера кабинетов видны только у выбранного корпуса
  h+='<g class="spots">';for(var sk in SPOTS){var q=SPOTS[sk],sz=zoneOf(sk);if(!sz||sz.k!==selZ)continue;h+='<circle'+(FLOOR[sk]===1?' class="up"':FLOOR[sk]===-1?' class="dn"':'')+' cx="'+q[0]+'" cy="'+q[1]+'" r="12"/><text class="sn" x="'+q[0]+'" y="'+(q[1]+1)+'">'+esc(sk.split(' ')[1])+'</text>';}
  PLACES.forEach(function(pl){if(pl.z!==selZ)return;h+='<circle class="pl" cx="'+pl.xy[0]+'" cy="'+pl.xy[1]+'" r="7"/>';});h+='</g>';
  var pz=zone(pinZ),ps=st.sel&&st.sel.r?spotOf(st.sel.r):null,px=ps?ps[0]:pz&&pz.x,py=ps?ps[1]:pz&&pz.y-42;
  // у верхнего края карты булавка перевёрнута (головкой вниз), иначе обрезается
  var fl=py<60,dy=fl?1:-1;
  if(pz)h+='<circle class="ring" cx="'+px+'" cy="'+(py+dy*28)+'" r="16"/><path class="pin" d="M'+px+' '+py+'c-10-14-20-22-20-34a20 20 0 0 1 40 0c0 12-10 20-20 34z"'+(fl?' transform="rotate(180 '+px+' '+py+')"':'')+'/><circle cx="'+px+'" cy="'+(py+dy*34)+'" r="7" fill="#171717" style="pointer-events:none"/>';
  return h+'<g id="smap-geo" style="pointer-events:none">'+geoSvg(selZ)+'</g></svg>';
}
// зум: кнопки «+ − ⟲ ⛶» и два пальца; viewBox хранится в st.vb и переживает перерисовку
function zoomBtns(){var zm=zoomed(),v=curVb();
  return '<div class="smap-zb">'+(st.full?'':'<button data-mact="full" aria-label="'+esc(tx('full'))+'">⛶</button>')+
    '<button data-mact="zin" aria-label="'+esc(tx('zin'))+'"'+(v.w<=vbMax().w/4+1?' disabled':'')+'>+</button>'+
    '<button data-mact="zout" aria-label="'+esc(tx('zout'))+'"'+(zm?'':' disabled')+'>−</button>'+(zm?'<button data-mact="zreset" aria-label="'+esc(tx('zreset'))+'">⟲</button>':'')+'</div>';}
function vbClamp(v){var m=vbMax(),a=asp(),w=Math.max(m.w/4,Math.min(m.w,v.w)),h=w*a,cx=v.x+v.w/2,cy=v.y+v.h/2;
  var x=Math.max(VB0.x,Math.min(VB0.x+VB0.w-w,cx-w/2)),y=Math.max(VB0.y,Math.min(VB0.y+VB0.h-h,cy-h/2));
  return w>=VB0.w-1&&h>=VB0.h-1?null:{x:x,y:y,w:w,h:h};}
// масштаб вокруг точки (px, py) в координатах плана
function vbZoom(k,px,py){var v=curVb();if(px==null){px=v.x+v.w/2;py=v.y+v.h/2;}
  st.vb=vbClamp({x:px-(px-v.x)/k,y:py-(py-v.y)/k,w:v.w/k,h:v.h/k});}
// экранная точка → координаты плана (с учётом полей при «вписать»)
function scrMap(v,r){var s=Math.max(v.w/r.width,v.h/r.height);return {s:s,ox:(r.width-v.w/s)/2,oy:(r.height-v.h/s)/2};}
// во весь экран: окно схемы — по размеру экрана, по центру — выбранная зона
function fullFit(root){var sv=root.querySelector('.smap-box.full .smap-svg');if(!sv)return;
  var r=sv.getBoundingClientRect();if(!r.width||!r.height)return;st.asp=r.height/r.width;
  var z=zone(curZ()),m=vbMax(),cx=z?z.x:VB0.x+VB0.w/2,cy=z?z.y:VB0.y+VB0.h/2;
  st.vb=vbClamp({x:cx-m.w/2,y:cy-m.h/2,w:m.w,h:m.h})||vbDef();sv.setAttribute('viewBox',vbStr());}
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
  PLACES.forEach(function(pl){var key=norm(pl.t.he+' '+pl.t.en+' '+pl.t.ru),ok=!!qn&&key.indexOf(qn)>=0&&shown<12;if(ok)shown++;
    h+='<button class="smap-row" data-mact="r" data-r="'+esc(pl.k)+'" data-key="'+esc(key)+'"'+(ok?'':' hidden')+'><bdi>'+esc(L(pl.t))+'</bdi><span class="zl">'+esc(L(zone(pl.z).lb))+'</span></button>';});
  h+='</div><div class="smap-nm" id="mapnm"'+(qn&&!shown?'':' hidden')+'>'+esc(tx('noMatch'))+'</div>';
  if(here.length){h+='<div class="smap-here">';
    here.forEach(function(x){h+='<button class="'+(selR===x.room?'on':'')+'" data-mact="r" data-r="'+esc(x.room)+'"><span class="k">'+esc(tx(x.k)||x.k)+'</span><span class="v"><bdi>'+esc(x.label||'')+'</bdi>'+(x.label?' · ':'')+'<bdi>'+esc(x.room)+'</bdi></span></button>';});
    h+='</div>';}
  var gl='<div class="smap-gline" id="smap-gline" role="status">'+geoLine(selZ)+'</div>';
  h+='<div class="smap-geo"><button class="smap-me'+(st.watch!=null?' on':'')+'" data-mact="geo" aria-pressed="'+(st.watch!=null)+'">📍 '+esc(tx(st.watch!=null?'geoOff':'geoBtn'))+'</button>'+(st.full?'':gl)+'</div>';
  h+='<div class="smap-box'+(st.full?' full':'')+'"'+(st.full?' role="dialog" aria-modal="true" aria-label="'+esc(tx('mapL'))+'"':'')+'>'+
    (st.full?'<button class="smap-x" data-mact="full" aria-label="'+esc(tx('fullX'))+'">✕</button>'+gl:'')+svg(selZ,selR?selZ:null)+zoomBtns()+'</div>';
  if(st.watch!=null)h+='<p class="smap-priv">'+esc(tx('geoPriv'))+(isIOS()?'<br>'+esc(tx('geoIos')):'')+'</p>';
  setTimeout(geoAuto,0);
  if(!sel)h+='<p class="smap-tip">'+esc(tx('tap'))+'</p>';
  if(selR){var z=zoneOf(selR);
    h+='<div class="smap-info"><h3><span class="r"><bdi>'+esc(rName(selR))+'</bdi></span></h3>';
    var fl=floorOf(selR);h+=z?'<p>'+esc((L(z.nm)||L(z.lb))+(fl!=null?' · '+tx(fl<0?'flDown':fl?'flUp':'flGround'):'')+(z.sub?' — '+L(z.sub):''))+'</p>':'<p>'+esc(tx('notOnR'))+'</p>';
    h+='</div>';}
  else if(selZ){var zz=zone(selZ),zr=rooms.filter(function(r){var q=zoneOf(r);return q&&q.k===selZ;});
    h+='<div class="smap-info"><h3>'+esc(L(zz.nm)||L(zz.lb))+'</h3>'+(zz.sub?'<p>'+esc(L(zz.sub))+'</p>':'');
    var zp=PLACES.filter(function(pl){return pl.z===selZ;});
    if(zr.length||zp.length){h+='<div class="smap-chips">';zr.forEach(function(r){h+='<button class="smap-chip" data-mact="r" data-r="'+esc(r)+'"><bdi>'+esc(short(r,zz))+'</bdi></button>';});zp.forEach(function(pl){h+='<button class="smap-chip" data-mact="r" data-r="'+esc(pl.k)+'"><bdi>'+esc(L(pl.t))+'</bdi></button>';});h+='</div>';}
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
    if(a==='go'){st.sel={r:el.getAttribute('data-r')};st.q='';st.full=false;st.vb=null;st.asp=null;if(CB.open)CB.open();return;}
    if(a==='full'){st.full=!st.full;st.vb=null;st.asp=null;if(CB.render)CB.render();if(st.full)fullFit(root);return;}
    if(a==='zin'||a==='zout'||a==='zreset'){if(a==='zreset'){st.vb=null;if(st.full){if(CB.render)CB.render();fullFit(root);return;}}else vbZoom(a==='zin'?1.6:1/1.6);if(CB.render)CB.render();return;}
    if(a==='geo'){if(st.watch!=null)geoStop();else geoStart();}
    else if(a==='z'){var k=el.getAttribute('data-z');st.sel=st.sel&&st.sel.z===k?null:{z:k};}
    else if(a==='r'){st.sel={r:el.getAttribute('data-r')};st.q='';}
    if(CB.render)CB.render();
    if(a==='r')focusMap(root);
  };
  // жесты на схеме: два пальца — зум, один палец в увеличенной схеме — сдвиг; после жеста нажатие не считается
  var ptr={},g0=null,moved=false,changed=false;
  var gStart=function(sv){var v=curVb(),P={};for(var k in ptr)P[k]={x:ptr[k].x,y:ptr[k].y};g0={sv:sv,vb:{x:v.x,y:v.y,w:v.w,h:v.h},p:P,r:sv.getBoundingClientRect()};};
  var gApply=function(){var sv=g0.sv;sv.setAttribute('viewBox',vbStr());sv.classList.toggle('zm',zoomed()||!!st.full);changed=true;};
  root.addEventListener('pointerdown',function(e){var sv=e.target.closest&&e.target.closest('.smap-svg');if(!sv)return;
    if(!Object.keys(ptr).length)moved=false;ptr[e.pointerId]={x:e.clientX,y:e.clientY};gStart(sv);});
  window.addEventListener('pointermove',function(e){if(!ptr[e.pointerId]||!g0)return;ptr[e.pointerId]={x:e.clientX,y:e.clientY};
    var ids=Object.keys(ptr),r=g0.r,M=scrMap(g0.vb,r),s0=M.s;
    if(ids.length===1){var a=ptr[ids[0]],a0=g0.p[ids[0]];if(!a0)return;var dx=a.x-a0.x,dy=a.y-a0.y;
      if(Math.abs(dx)+Math.abs(dy)>6)moved=true;if(!(zoomed()||st.full)||!moved)return;
      st.vb=vbClamp({x:g0.vb.x-dx*s0,y:g0.vb.y-dy*s0,w:g0.vb.w,h:g0.vb.h});gApply();}
    else if(ids.length>=2){var p=ptr[ids[0]],q=ptr[ids[1]],p0=g0.p[ids[0]],q0=g0.p[ids[1]];if(!p0||!q0)return;
      var d0=Math.hypot(p0.x-q0.x,p0.y-q0.y)||1,d=Math.hypot(p.x-q.x,p.y-q.y)||1,k=d/d0;moved=true;
      var mx0=g0.vb.x+((p0.x+q0.x)/2-r.left-M.ox)*s0,my0=g0.vb.y+((p0.y+q0.y)/2-r.top-M.oy)*s0,w=g0.vb.w/k,h=g0.vb.h/k,M1=scrMap({w:w,h:h},r);
      st.vb=vbClamp({x:mx0-((p.x+q.x)/2-r.left-M1.ox)*M1.s,y:my0-((p.y+q.y)/2-r.top-M1.oy)*M1.s,w:w,h:h});gApply();}
  });
  var gEnd=function(e){if(!ptr[e.pointerId])return;delete ptr[e.pointerId];
    if(Object.keys(ptr).length){if(g0)gStart(g0.sv);return;}
    g0=null;if(changed){changed=false;if(CB.render)CB.render();}};
  window.addEventListener('pointerup',gEnd);window.addEventListener('pointercancel',gEnd);
  // компьютер: колёсико с Ctrl (и щипок на тачпаде) — зум вокруг курсора
  root.addEventListener('wheel',function(e){var sv=e.target.closest&&e.target.closest('.smap-svg');if(!sv||!e.ctrlKey)return;e.preventDefault();
    var r=sv.getBoundingClientRect(),v=curVb(),M=scrMap(v,r);vbZoom(e.deltaY<0?1.15:1/1.15,v.x+(e.clientX-r.left-M.ox)*M.s,v.y+(e.clientY-r.top-M.oy)*M.s);
    sv.setAttribute('viewBox',vbStr());sv.classList.toggle('zm',zoomed()||!!st.full);clearTimeout(bind.wt);bind.wt=setTimeout(function(){if(CB.render)CB.render();},300);},{passive:false});
  window.addEventListener('resize',function(){if(st.full){var v=curVb(),c={x:v.x+v.w/2,y:v.y+v.h/2},sv=root.querySelector('.smap-box.full .smap-svg');if(!sv)return;var r=sv.getBoundingClientRect();if(!r.width)return;st.asp=r.height/r.width;var w=v.w,h=w*st.asp;st.vb=vbClamp({x:c.x-w/2,y:c.y-h/2,w:w,h:h});sv.setAttribute('viewBox',vbStr());}});
  document.addEventListener('keydown',function(e){if(e.key==='Escape'&&st.full){st.full=false;st.vb=null;st.asp=null;if(CB.render)CB.render();}});
  // фаза захвата: нажатие на кабинет внутри карточки урока не доходит до обработчика самой карточки
  root.addEventListener('click',function(e){var el=e.target.closest&&e.target.closest('[data-mact]');if(!el||!root.contains(el))return;
    if(moved&&el.closest('.smap-svg')){moved=false;e.stopPropagation();e.preventDefault();return;}act(el,e);},true);
  root.addEventListener('keydown',function(e){if(e.key!=='Enter'&&e.key!==' ')return;var el=e.target.closest&&e.target.closest('[data-mact]');if(el&&el.tagName!=='BUTTON')act(el,e);});
  root.addEventListener('input',function(e){if(!e.target||e.target.id!=='mapq')return;st.q=e.target.value;var q=norm(st.q),n=0;
    root.querySelectorAll('#mapres [data-key]').forEach(function(b){var ok=!!q&&b.getAttribute('data-key').indexOf(q)>=0&&n<12;b.hidden=!ok;if(ok)n++;});
    var res=document.getElementById('mapres'),nm=document.getElementById('mapnm');if(res)res.hidden=!q;if(nm)nm.hidden=!(q&&!n);});
}
// открыть карту с выбранным кабинетом (или без выбора)
function show(room){st.sel=room?{r:String(room)}:null;st.q='';st.vb=null;st.full=false;st.asp=null;}
// атрибуты для кабинета в карточке урока: нажатие открывает карту
function attr(room){return room?' data-mact="go" data-r="'+esc(room)+'" role="button" tabindex="0"':'';}
window.SkedyMap={html:html,bind:bind,show:show,attr:attr,zoneOf:function(r){var z=zoneOf(r);return z?z.k:null;},prefetch:load};
})();
