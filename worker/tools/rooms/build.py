#!/usr/bin/env python3
# Свободные кабинеты для Skedy Teachers: какой кабинет на каком уроке занят по постоянному расписанию всей школы.
# Берёт вкладку timetable שחף у всех классов (ז׳–י״ב) и пишет teacher/rooms.json.
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

def class_ids(page):
    return [v for v, t in re.findall(r'<option[^>]*value="(\d+)"[^>]*>([\s\S]*?)</option>', page)]

def main():
    os.makedirs(CACHE, exist_ok=True)
    cached = '--cached' in sys.argv
    ids = class_ids(open(CACHE + '/idx.html', encoding='utf-8').read() if cached else get(BASE + '?tab=timetable'))
    busy = {}   # кабинет -> [битовая маска уроков на каждый день вс–чт]
    for cid in ids:
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
                    r = re.search(r'</b>(?:&nbsp;)*\s*\(([\s\S]*?)\)\s*<br', les)
                    if not r:
                        continue
                    room = re.sub(r'\s+', ' ', html.unescape(r.group(1))).strip()
                    busy.setdefault(room, [0] * 5)[d] |= 1 << p
    rooms = {k: v for k, v in sorted(busy.items()) if not SKIP.search(k)}
    out = {'updated': datetime.date.today().isoformat(), 'classes': len(ids), 'rooms': rooms}
    with open('teacher/rooms.json', 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    print('классов:', len(ids), 'кабинетов:', len(rooms), 'пропущено:', len(busy) - len(rooms))

main()
