import re,html,json,sys
SIDS={'י':[24,25,26,27,28,29,30,31,52,56,59,86],'יא':[33,34,35,36,37,38,39,48,57,58,60],'יב':[40,41,42,43,44,45,50,54,61,62,66]}
def parse(sid):
    s=open(f'/tmp/sh/tt_{sid}.html',encoding='utf-8').read()
    t=s[s.find('<table'):s.find('</table>')]
    out=[]
    for row in re.findall(r'<tr>([\s\S]*?)</tr>',t):
        m=re.search(r'class="CName"><b>(\d+)</b>',row)
        if not m: continue
        p=int(m.group(1))
        for d,cell in re.findall(r'<td class="TTCell" data-day="(\d)">([\s\S]*?)</td>',row):
            for les in re.findall(r'<div class="TTLesson">([\s\S]*?)</div>',cell):
                mm=re.match(r'\s*<b>([\s\S]*?)</b>(?:&nbsp;)*\s*(?:\(([\s\S]*?)\))?\s*<br/>([\s\S]*)',les)
                if not mm: print('??',les,file=sys.stderr);continue
                subj,room,teach=[html.unescape(x or '').strip() for x in mm.groups()]
                out.append(dict(day=int(d),period=p,subj=subj,room=room,teacher=re.sub(r'<[^>]+>','',teach).strip()))
    return out
if __name__=='__main__':
    all={g:{i+1:parse(s) for i,s in enumerate(v)} for g,v in SIDS.items()}
    json.dump(all,open('/tmp/sh/all.json','w'),ensure_ascii=False)
    for g in all: print(g,[len(x) for x in all[g].values()])
