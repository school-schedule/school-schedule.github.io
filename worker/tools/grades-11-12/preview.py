import os,json,re
# Пробник Skedy для י״א и י״ב: приложение учеников (как сейчас в index.html) + классы, группы и уроки י״א/י״ב из new.json.
# Пишет preview/index.html в корне репозитория (на сайте — school-schedule.github.io/preview/).
# Пробник не ходит на сервер (нет config.js): только встроенные данные, без входа редактора, уведомлений, друзей и счётчика.
# Память — своя (skedyP.*, а не sched.*), чтобы выбор в пробнике не сбил выбор в настоящем приложении на том же сайте.
SH=os.environ.get('SH','/tmp/sh');ROOT=os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)),'..','..','..'))
s=open(os.path.join(ROOT,'index.html'),encoding='utf-8').read()
i=s.index('id="app-state">')+15;j=s.index('</script>',i);st=json.loads(s[i:j])
# new.json: свежий из $SH, иначе копия рядом со скриптом
NJ=SH+'/new.json' if os.path.exists(SH+'/new.json') else os.path.join(os.path.dirname(os.path.abspath(__file__)),'new.json')
N=json.load(open(NJ,encoding='utf-8'))
for g in st['groups']:
    if not g.get('classId'): g['exceptClasses']=(g.get('exceptClasses') or [])+N['exceptOld']
for k in ('classes','subjects','groups','lessons'): st[k]+=N['add'][k]
# английский открыт для всех классов, где он есть (как миграция Worker eng-open-2026-10-28)
for x in st['subjects']:
    if x['id']=='cat_eng': x['open']=True
st['changes']=[];st['events']=[]
import datetime;st['updatedAt']=datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')  # «Обновлено» в подвале = когда собран пробник
html=s[:i]+json.dumps(st,ensure_ascii=False,separators=(',',':'))+s[j:]
def rep(a,b,n=1):
    global html
    assert html.count(a)==n,(a,html.count(a));html=html.replace(a,b)
rep('<script src="config.js"></script>','<meta name="robots" content="noindex">')
rep('<link rel="manifest" href="manifest.webmanifest">','')
rep("<title>Skedy</title>","<title>Skedy · י״א / י״ב</title>")
rep("if(location.hostname!=='school-schedule.github.io')return;","return;")  # без статистики посещений
rep("location.href='teacher/'","location.href='../teacher/'")
rep("location.href='parents/'","location.href='../parents/'")
rep('<script src="map.js"></script>','<script src="../map.js"></script>')  # карта школы — общий файл в корне
a=html.index('<script id="app-js">')
js=html[a:];n=js.count("'sched.");assert n>40,n
html=html[:a]+js.replace("'sched.","'skedyP.")
os.makedirs(os.path.join(ROOT,'preview'),exist_ok=True)
open(os.path.join(ROOT,'preview','index.html'),'w',encoding='utf-8').write(html)
print('preview/index.html',len(html),'классов',len(st['classes']),'уроков',len(st['lessons']))
