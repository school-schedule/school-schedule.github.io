import json,re,collections
A=json.load(open('/tmp/sh/all.json'));N=json.load(open('/tmp/sh/new.json'))['add']
s=open('/home/user/school-schedule.github.io/index.html',encoding='utf-8').read()
i=s.index('id="app-state">')+15;j=s.index('</script>',i);base=json.loads(s[i:j])
SKIP=re.compile(r'הוראה מתקנת|ארוחת צהריים|פרטני')
subj={x['id']:x['he'] for x in base['subjects']+N['subjects']}
def fits(g,c):
    if c in (g.get('exceptClasses') or []): return False
    return not g.get('classId') or g['classId']==c
bad=0
for G,num in (('יא',11),('יב',12)):
    for c,ls in A[G].items():
        cid='c%d_%s'%(num,c)
        want={(l['day'],l['period'],re.sub(r'\s+',' ',l['subj']).strip(),re.sub(r'\s+',' ',l['teacher']).strip()) for l in ls if l['day']<=4 and not SKIP.search(l['subj'])}
        gids={g['id'] for g in N['groups'] if fits(g,cid)}
        have={(l['day'],l['period'],subj[l['subjectId']],l['teacher']) for l in N['lessons'] if (l['aud']['type']=='class' and l['aud']['id']==cid) or (l['aud']['type']=='group' and l['aud']['id'] in gids)}
        miss=want-have; extra=have-want
        if miss or extra: bad+=1;print(cid,'miss',len(miss),list(miss)[:3],'extra',len(extra),list(extra)[:3])
    # старые группы י не должны подходить новым классам после исключения
print('classes with problems:',bad)
