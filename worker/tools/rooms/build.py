#!/usr/bin/env python3
# Данные для Skedy Teachers по постоянному расписанию всей школы (вкладка timetable שחף у всех классов ז׳–י״ב):
#   teacher/rooms.json    — какой кабинет на каком уроке занят («Свободные кабинеты»);
#   teacher/teachers.json — уроки каждого учителя: день, урок, предмет, кабинет, классы («Где учитель»);
#   teacher/classes/<параллель>-<номер>.json — уроки одного класса: день, урок, предмет, кабинет, учитель («Мой класс»;
#     по файлу на класс, чтобы учитель скачивал только свой), teacher/classes/index.json — список классов.
# Запуск из корня репозитория (нужен доступ к kfaryarok.shahaf.site):
#   python3 worker/tools/rooms/build.py            — скачать страницы и собрать файл
#   python3 worker/tools/rooms/build.py --cached   — собрать из уже скачанных /tmp/sh/tt_*.html
# Пересобирать, когда в школе меняется расписание (например, в начале полугодия).
import re, html, json, sys, os, datetime, urllib.request

BASE = 'https://kfaryarok.shahaf.site/'
CACHE = '/tmp/sh'
# не кабинеты для урока или контрольной: столовая, спорт, кабинеты специалистов
SKIP = re.compile(r'חדר אוכל|אולם ספורט|חנ"ג|גן מקלט|יועצת|רכזת|פרטני|מרכז למידה')

def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Skedy rooms builder (school schedule app)'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode('utf-8')

def class_opts(page):
    return [(v, re.sub(r'\s', '', html.unescape(t))) for v, t in re.findall(r'<option[^>]*value="(\d+)"[^>]*>([\s\S]*?)</option>', page)]

GRADE = {'ז': 'ז׳', 'ח': 'ח׳', 'ט': 'ט׳', 'י': 'י׳', 'יא': 'י״א', 'יב': 'י״ב'}
def aud_label(classes):
    # «יא-2» → «י״א2»; больше трёх классов одной параллели — «שכבת י״א»
    by = {}
    for c in classes:
        g, n = c.split('-')
        by.setdefault(g, []).append(int(n))
    out = []
    for g in sorted(by, key=lambda x: list(GRADE).index(x) if x in GRADE else 99):
        ns = sorted(by[g])
        out.append('שכבת ' + GRADE.get(g, g) if len(ns) > 3 else ', '.join(GRADE.get(g, g) + str(n) for n in ns))
    return ', '.join(out)

def clean(x):
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', '', x or ''))).strip()

def main():
    os.makedirs(CACHE, exist_ok=True)
    cached = '--cached' in sys.argv
    opts = class_opts(open(CACHE + '/idx.html', encoding='utf-8').read() if cached else get(BASE + '?tab=timetable'))
    busy = {}   # кабинет -> [битовая маска уроков на каждый день вс–чт]
    tl = {}     # (учитель, день, урок, предмет, кабинет) -> классы
    cl = {}     # класс -> список (день, урок, предмет, кабинет, учитель)
    for cid, cname in opts:
        path = '%s/tt_%s.html' % (CACHE, cid)
        if cached:
            page = open(path, encoding='utf-8').read()
        else:
            page = get(BASE + '?cls=%s&tab=timetable' % cid)
            open(path, 'w', encoding='utf-8').write(page)
        t = page[page.find('<table'):page.find('</table>')]
        for row in re.findall(r'<tr>([\s\S]*?)</tr>', t):
            m = re.search(r'class="CName"><b>(\d+)</b>', row)
            if not m:
                continue
            p = int(m.group(1))
            for d, cell in re.findall(r'<td class="TTCell" data-day="(\d)">([\s\S]*?)</td>', row):
                d = int(d)
                if d > 4:
                    continue
                for les in re.findall(r'<div class="TTLesson">([\s\S]*?)</div>', cell):
                    mm = re.match(r'\s*<b>([\s\S]*?)</b>(?:&nbsp;)*\s*(?:\(([\s\S]*?)\))?\s*<br/>([\s\S]*)', les)
                    if not mm:
                        continue
                    subj, room, teacher = [clean(x) for x in mm.groups()]
                    if room:
                        busy.setdefault(room, [0] * 5)[d] |= 1 << p
                    if teacher:
                        tl.setdefault((teacher, d, p, subj, room), set()).add(cname)
                    if subj:
                        cl.setdefault(cname, []).append((d, p, subj, room, teacher))
    rooms = {k: v for k, v in sorted(busy.items()) if not SKIP.search(k)}
    today = datetime.date.today().isoformat()
    out = {'updated': today, 'classes': len(opts), 'rooms': rooms}
    with open('teacher/rooms.json', 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    # уроки учителей: строки предметов, кабинетов и классов — в общих списках, в уроке только их номера
    S, R, A, T = [], [], [], {}
    def ix(lst, v):
        if v not in lst:
            lst.append(v)
        return lst.index(v)
    for (teacher, d, p, subj, room), cls in sorted(tl.items(), key=lambda x: (x[0][0], x[0][1], x[0][2])):
        T.setdefault(teacher, []).append([d, p, ix(S, subj), ix(R, room), ix(A, aud_label(cls))])
    with open('teacher/teachers.json', 'w', encoding='utf-8') as f:
        json.dump({'updated': today, 's': S, 'r': R, 'a': A, 't': T}, f, ensure_ascii=False, separators=(',', ':'))
    # уроки классов: по файлу на класс, имя файла — номер параллели и класса («יא-2» → 11-2.json)
    NUM = {'ז': 7, 'ח': 8, 'ט': 9, 'י': 10, 'יא': 11, 'יב': 12}
    os.makedirs('teacher/classes', exist_ok=True)
    for f in os.listdir('teacher/classes'):
        os.remove('teacher/classes/' + f)
    index = []
    for cid, cname in opts:
        g, n = cname.split('-')
        key = '%d-%s' % (NUM.get(g, 0), n)
        cs, cr, ct = [], [], []
        ls = [[d, p, ix(cs, subj), ix(cr, room), ix(ct, teacher)] for d, p, subj, room, teacher in sorted(set(cl.get(cname, [])))]
        with open('teacher/classes/%s.json' % key, 'w', encoding='utf-8') as f:
            json.dump({'updated': today, 's': cs, 'r': cr, 't': ct, 'l': ls}, f, ensure_ascii=False, separators=(',', ':'))
        index.append({'k': key, 'he': GRADE.get(g, g) + n, 'g': NUM.get(g, 0), 'n': int(n)})
    index.sort(key=lambda x: (x['g'], x['n']))
    with open('teacher/classes/index.json', 'w', encoding='utf-8') as f:
        json.dump({'updated': today, 'classes': index}, f, ensure_ascii=False, separators=(',', ':'))
    print('классов:', len(opts), 'кабинетов:', len(rooms), 'пропущено:', len(busy) - len(rooms), 'учителей:', len(T), 'уроков:', len(tl))

main()
