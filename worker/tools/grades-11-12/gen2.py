import json,collections,re,sys
sys.path.insert(0,'/tmp/scripts')
from gen import build,norm
s=open('/home/user/school-schedule.github.io/index.html',encoding='utf-8').read()
i=s.index('id="app-state">')+15;j=s.index('</script>',i);base=json.loads(s[i:j])
TR={'ביולוגיה חקלאית':('Agricultural biology','Агробиология'),'ביולוגיה חקלאית - בעלי חיים':('Agricultural biology: animals','Агробиология: животные'),
'הלחנה':('Composition','Композиция'),'הנדסת תוכנה התמחות':('Software engineering (specialization)','Программная инженерия (специализация)'),
"הנדסת תוכנה התמחות שלב א' תכנות ניידים":('Software engineering: mobile programming','Программная инженерия: мобильная разработка'),
'הרכב קלאסי':('Classical ensemble','Классический ансамбль'),'מבוא להנדסת מחשבים א':('Intro to computer engineering A','Введение в компьютерную инженерию А'),
'מבני נתונים':('Data structures','Структуры данных'),'מדעי המחשב - אינטרנט':('Computer science: web','Информатика: интернет'),
'מודלים - נושאי ליבה AI':('Models: AI core topics','Модели: основы ИИ'),'מודלים חישוביים':('Computational models','Вычислительные модели'),
'מונולוג ודיאלוג':('Monologue and dialogue','Монолог и диалог'),'מיקרו בקרים':('Microcontrollers','Микроконтроллеры'),
'מעבדה במיקרו בקרים':('Microcontrollers lab','Лаб. микроконтроллеров'),'מעבדת פרוייקטים':('Projects lab','Лаб. проектов'),
'מערכות אלקטרוניות':('Electronic systems','Электронные системы'),'מקהלה קלאסית':('Classical choir','Классический хор'),'ניצוח':('Conducting','Дирижирование'),
'סדנת גיטריסטים קלאסי':('Classical guitar workshop','Мастерская классической гитары'),"סולפז' ושירת מגמה":('Solfège and major singing','Сольфеджио и пение'),
'פרויקט חברתי מוסיקאלי קלאסי':('Classical music social project','Социальный музыкальный проект'),'פרויקטים במוסיקה גר"פ':('Music projects','Музыкальные проекты'),
'שירה':('Singing','Пение'),'תולדות האומנות':('Art history','История искусства'),'תיאטרון הפקה':('Theatre production','Театральная постановка'),'תנ"ך':('Bible','ТАНАХ')}
HEB=['א','ב','ג','ד','ה','ו','ז','ח']
out={'classes':[],'subjects':[],'groups':[],'lessons':[]}
subjByHe={x['he']:x for x in base['subjects'] if not x['id'].startswith('cat')}
def subj(he):
    if he in subjByHe: return subjByHe[he]
    en,ru=TR[he];x={'id':'s_'+str(len(out['subjects'])+200),'he':he,'en':en,'ru':ru}
    subjByHe[he]=x;out['subjects'].append(x);return x
def label(names,lang):
    return ' / '.join((subj(n)['he'] if lang=='he' else subj(n)[lang]) for n in names)
allNew=[]
for G,num in (('יא',11),('יב',12)):
    inst,room,classLessons,cats=build(G)
    cid=lambda c:'c%d_%s'%(num,c)
    gheb='י״א' if num==11 else 'י״ב'
    for c in sorted(A_ for A_ in {c for k in inst for c in inst[k]}) if False else []: pass
    ncls=sorted({c for k in inst for c in inst[k]},key=int)
    for c in ncls: out['classes'].append({'id':cid(c),'he':gheb+c,'en':gheb+c,'ru':gheb+c,'letter':G,'num':int(c)})
    L=[0]
    def addL(k,aud):
        L[0]+=1;s_=subj(k[2]);r=room[k].most_common(1)[0][0]
        out['lessons'].append({'id':'L%d_%d'%(num,L[0]),'day':k[0],'period':k[1],'subjectId':s_['id'],'aud':aud,'teacher':k[3],'room':r})
    for c,k in sorted(classLessons,key=lambda x:(int(x[0]),x[1])): addL(k,{'type':'class','id':cid(c)})
    # имена категорий
    named=[]
    for c in cats:
        if c['fam']=='math': nm=('מתמטיקה','Math','Математика','math')
        elif c['fam']=='eng': nm=('אנגלית','English','Английский','eng')
        elif c['fam']=='pe': nm=('חנ"ג','PE','Физкультура','pe')
        else:
            cnt=collections.Counter(k[2] for k in c['inst']);top,n=cnt.most_common(1)[0]
            nm=(top,subj(top)['en'],subj(top)['ru'],None) if n/sum(cnt.values())>=0.6 else None
        named.append((nm,c))
    merged=collections.OrderedDict()
    for nm,c in named:
        key=nm[0] if nm else id(c)
        if key in merged: merged[key][1].append(c)
        else: merged[key]=[nm,[c]]
    clusters=[v for v in merged.values() if v[0] is None]
    clusters.sort(key=lambda v:min((k[0],k[1]) for k in v[1][0]['inst']))
    for n,v in enumerate(clusters): v[0]=('אשכול '+HEB[n]+'׳','Cluster '+'ABCDEFGH'[n],'Блок '+'АБВГДЕЖЗ'[n],'c'+'abcdefgh'[n])
    order={'math':0,'eng':1}
    cats2=sorted(merged.values(),key=lambda v:(order.get(v[0][3],2) if v[0][3] else 2, v[0][3]=='pe', v[0][0]))
    gn=[0]
    for nm,cs in cats2:
        he,en,ru,slug=nm
        SLUG={'הבעה ולשון':'lashon','היסטוריה':'hist','ספרות':'lit','תנ"ך':'tanach','אזרחות':'civics','ביולוגיה חקלאית':'agrobio','הרכבים':'ens'}
        catId='cat%d_%s'%(num,slug or SLUG.get(he) or 'x%d'%len(out['subjects']))
        single=slug in('math','eng','pe')
        cat={'id':catId,'he':he,'en':en,'ru':ru,'multi':not single}
        if slug=='eng': cat['open']=True  # как в י׳: ученики учатся английскому не только со своим классом
        out['subjects'].append(cat)
        inst_=set().union(*[c['inst'] for c in cs])
        if slug=='pe':
            keyf=lambda k:(sorted(inst[k],key=int)[0] if False else None)
            groups=collections.defaultdict(set)
            for k in inst_:
                for c in inst[k]: groups[(c,k[2])].add(k)
            items=[((c,sj),ks,[c]) for (c,sj),ks in groups.items()]
        else:
            groups=collections.defaultdict(set)
            for k in inst_: groups[(k[3],tuple(sorted(inst[k],key=int)))].add(k)
            items=[(t,ks,sorted(set().union(*[inst[k] for k in ks]),key=int)) for t,ks in groups.items()]
        for key,ks,clsl in sorted(items,key=lambda x:str(x[0])):
            gn[0]+=1;gid='g%d_%d'%(num,gn[0])
            names=list(dict.fromkeys(k[2] for k in sorted(ks)))
            teachers=sorted({k[3] for k in ks})
            g={'id':gid,'subjectId':catId}
            if slug in('math','eng'): g.update(he=he,en=en,ru=ru)
            else: g.update(he=label(names,'he'),en=label(names,'en'),ru=label(names,'ru'))
            g['teacher']=' / '.join(teachers)
            g['_cls']=[cid(c) for c in clsl]
            out['groups'].append(g)
            for k in sorted(ks): addL(k,{'type':'group','id':gid})
        if not single:
            real=sorted({c for g in out['groups'] if g['subjectId']==catId for c in g['_cls']})
            out['groups'].append({'id':catId.replace('cat','g')+'_free','subjectId':catId,'he':'שיעור חופשי','en':'Free period','ru':'Свободный урок','teacher':'','free':True,'_cls':real})
# ограничения по классам: все классы (י + новые)
allc=[c['id'] for c in base['classes']]+[c['id'] for c in out['classes']]
newc=[c['id'] for c in out['classes']]
for g in out['groups']:
    cl=g.pop('_cls')
    if len(cl)==1: g['classId']=cl[0]
    else:
        ex=[c for c in allc if c not in cl]
        if ex: g['exceptClasses']=ex
oldExcept={g['id']:[c for c in newc] for g in base['groups'] if not g.get('classId')}
json.dump({'add':out,'exceptOld':newc},open('/tmp/sh/new.json','w'),ensure_ascii=False)
print({k:len(v) for k,v in out.items()})
for x in out['subjects']:
    if x['id'].startswith('cat'): print(x['id'],x['he'],'multi' if x['multi'] else '', sum(1 for g in out['groups'] if g['subjectId']==x['id']),'groups')
