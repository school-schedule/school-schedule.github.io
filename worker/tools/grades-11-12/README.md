# Импорт י״א и י״ב из שחף (черновик)

Скрипты, которыми собраны классы, группы и уроки י״א и י״ב из вкладки `timetable` שחף.
Ещё не подключено ни к сайту, ни к Worker: сначала проверка учениками י״א/י״ב.

1. Скачать страницы: `https://kfaryarok.shahaf.site/?cls=<id>&tab=timetable` в `/tmp/sh/tt_<id>.html` (id — в `parse.py`).
2. `python3 parse.py` → `/tmp/sh/all.json`
3. `python3 gen2.py` → `/tmp/sh/new.json` (новые классы, предметы, группы, уроки; `exceptOld` — id новых классов, которые надо добавить в `exceptClasses` старых групп י׳ без `classId`).
4. `python3 check.py` — у каждого класса уроки должны совпасть с שחף (`classes with problems: 0`).

Пропускаются «הוראה מתקנת», «פרטני», «ארוחת צהריים» и пятница.
