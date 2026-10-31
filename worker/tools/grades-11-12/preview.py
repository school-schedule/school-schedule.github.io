import json
src='/home/user/school-schedule.github.io/index.html'
s=open(src,encoding='utf-8').read()
i=s.index('id="app-state">')+15;j=s.index('</script>',i);st=json.loads(s[i:j])
N=json.load(open('/tmp/sh/new.json'))
for g in st['groups']:
    if not g.get('classId'): g['exceptClasses']=(g.get('exceptClasses') or [])+N['exceptOld']
for k in ('classes','subjects','groups','lessons'): st[k]+=N['add'][k]
st['updatedAt']='2099-01-01T00:00:00Z'
import os;os.makedirs('/tmp/prev',exist_ok=True)
open('/tmp/prev/index.html','w',encoding='utf-8').write(s[:i]+json.dumps(st,ensure_ascii=False,separators=(',',':'))+s[j:])
for f in ('config.js','sw.js','manifest.webmanifest'):
    os.system(f'cp /home/user/school-schedule.github.io/{f} /tmp/prev/')
print(len(json.dumps(st,ensure_ascii=False,separators=(',',':'))))
