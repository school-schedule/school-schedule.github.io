import json,collections,re,sys
A=json.load(open('/tmp/sh/all.json'))
SKIP=re.compile(r'הוראה מתקנת|ארוחת צהריים|פרטני')
LET={'יא':('יא','י״א','11'),'יב':('יב','י״ב','12')}
def norm(s): return re.sub(r'\s+',' ',s).strip()
def build(G):
    cls=A[G]; tag=LET[G][2]
    inst=collections.defaultdict(set); room={}
    cells=collections.defaultdict(list)
    for c,ls in cls.items():
        for l in ls:
            if l['day']>4 or SKIP.search(l['subj']): continue
            k=(l['day'],l['period'],norm(l['subj']),norm(l['teacher']))
            inst[k].add(c); room.setdefault(k,collections.Counter())[l['room']]+=1
            if k not in cells[(c,l['day'],l['period'])]: cells[(c,l['day'],l['period'])].append(k)
    grouptype=set()
    for ks in cells.values():
        if len(ks)>1: grouptype|=set(ks)
    classLessons=[(c,k) for k in inst if k not in grouptype for c in inst[k]]
    # union-find по клеткам
    par={k:k for k in grouptype}
    def f(x):
        while par[x]!=x: par[x]=par[par[x]];x=par[x]
        return x
    def u(a,b): par[f(a)]=f(b)
    for ks in cells.values():
        g=[k for k in ks if k in grouptype]
        for k in g[1:]: u(k,g[0])
    comp=collections.defaultdict(set)
    for k in grouptype: comp[f(k)].add(k)
    def fam(k):
        s=k[2]
        if s=='מתמטיקה': return 'math'
        if s=='אנגלית': return 'eng'
        if s.startswith('חנ"ג'): return 'pe'
        return 'x'
    # разделить компоненты по семействам (математика/англ/физ-ра отдельно)
    pieces=[]
    for b in comp.values():
        byf=collections.defaultdict(set)
        for k in b: byf[fam(k)].add(k)
        for fm,s in byf.items(): pieces.append((fm,s))
    cats=[]
    for fm,b in sorted(pieces,key=lambda x:(x[0],min(x[1]))):
        T={k[3] for k in b}; C=set().union(*[inst[k] for k in b])
        best=None
        for c in cats:
            if c['fam']!=fm: continue
            if fm in('math','eng'): best=c;break
            if fm=='pe': continue
            if len(T&c['T'])/min(len(T),len(c['T']))>=0.5 and C&c['C']: best=c;break
        if best: best['T']|=T;best['C']|=C;best['inst']|=b
        else: cats.append({'fam':fm,'T':set(T),'C':set(C),'inst':set(b)})
    return inst,room,classLessons,cats
if __name__=='__main__':
    for G in ('יא','יב'):
        inst,room,cl,cats=build(G)
        print('=====',G,'class lessons',len(cl),'cats',len(cats))
        for c in sorted(cats,key=lambda c:(c['fam'],-len(c['inst']))):
            if c['fam']=='pe': continue
            subs=collections.Counter(k[2] for k in c['inst'])
            slots=sorted({(k[0],k[1]) for k in c['inst']})
            print(c['fam'],len(slots),'slots',slots,'| teachers',len(c['T']),'| classes',sorted(c['C'],key=int))
            print('    ',dict(subs.most_common(30)))
        pe=[c for c in cats if c['fam']=='pe'];print('pe cats',len(pe),[sorted(c['C'],key=int) for c in pe])
