#!/usr/bin/env node
// Проверка кода после каждого изменения (хук PostToolUse для Claude Code).
// Читает из stdin JSON хука, берёт путь изменённого файла и проверяет его.
// Можно запустить и вручную: node .claude/hooks/check-code.mjs index.html
// Код выхода 2 = найдены ошибки (Claude видит их и должен исправить), 0 = всё в порядке.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';

function readInput() {
  if (process.argv[2]) return process.argv[2];
  try {
    const j = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    return (j.tool_input && j.tool_input.file_path) || (j.tool_response && j.tool_response.filePath) || '';
  } catch (e) { return ''; }
}

// Проверяет синтаксис JS, не выполняя код
function checkJs(code, label, errors) {
  try { new vm.Script(code, { filename: label }); }
  catch (e) {
    const where = (e.stack || '').split('\n')[0];
    errors.push(`${label}: синтаксическая ошибка JS — ${e.message}${where.includes(':') ? ' (' + where + ')' : ''}`);
  }
}

// .mjs — это модуль (import/export): vm.Script его не разбирает, поэтому проверяем через node --check
function checkModule(file, label, errors) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status === 0) return;
  const lines = (r.stderr || '').split('\n');
  const where = (lines.find(l => l.startsWith(file + ':')) || '').slice(file.length + 1);
  const msg = lines.find(l => /Error\b/.test(l)) || 'не удалось проверить';
  errors.push(`${label}: синтаксическая ошибка JS — ${msg.trim().replace(/^SyntaxError: /, '')}${where ? ' (' + label + ':' + where + ')' : ''}`);
}

function lineOf(text, idx) { return text.slice(0, idx).split('\n').length; }

function checkData(st, errors) {
  const need = ['periods', 'subjects', 'classes', 'groups', 'lessons', 'changes'];
  for (const k of need) if (!Array.isArray(st[k])) { errors.push(`app-state: нет массива "${k}"`); return; }
  const ids = (list, name) => {
    const s = new Set();
    for (const x of list) {
      if (!x || x.id == null) { errors.push(`app-state: в "${name}" есть запись без id`); continue; }
      if (s.has(x.id)) errors.push(`app-state: повторяющийся id "${x.id}" в "${name}"`);
      s.add(x.id);
    }
    return s;
  };
  const subj = ids(st.subjects, 'subjects'), cls = ids(st.classes, 'classes');
  const grp = ids(st.groups, 'groups'), les = ids(st.lessons, 'lessons');
  ids(st.changes, 'changes');
  const periods = new Set(st.periods.map(p => p.n));
  for (const g of st.groups) {
    if (!subj.has(g.subjectId)) errors.push(`группа ${g.id}: нет предмета "${g.subjectId}"`);
    if (g.classId && !cls.has(g.classId)) errors.push(`группа ${g.id}: нет класса "${g.classId}"`);
  }
  for (const l of st.lessons) {
    if (!subj.has(l.subjectId)) errors.push(`урок ${l.id}: нет предмета "${l.subjectId}"`);
    if (!(l.day >= 0 && l.day <= 4)) errors.push(`урок ${l.id}: день ${l.day} вне диапазона 0–4 (вс–чт)`);
    if (!periods.has(l.period)) errors.push(`урок ${l.id}: нет урока номер ${l.period} в periods`);
    const a = l.aud || {};
    if (a.type === 'class' ? !cls.has(a.id) : a.type === 'group' ? !grp.has(a.id) : true)
      errors.push(`урок ${l.id}: неверное "для кого" ${JSON.stringify(a)}`);
  }
  const TYPES = ['cancel', 'room', 'test', 'exam'];
  for (const c of st.changes) {
    if (!les.has(c.lessonId)) errors.push(`изменение ${c.id}: нет урока "${c.lessonId}"`);
    if (!TYPES.includes(c.type)) errors.push(`изменение ${c.id}: неизвестный тип "${c.type}"`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(c.date || '')) errors.push(`изменение ${c.id}: дата не в формате ГГГГ-ММ-ДД`);
  }
}

function checkIndex(html, errors) {
  // 1) данные расписания
  const sOpen = '<script type="application/json" id="app-state">';
  const si = html.indexOf(sOpen);
  if (si < 0) errors.push('index.html: не найден <script id="app-state"> с данными');
  else {
    const se = html.indexOf('</script>', si + sOpen.length);
    const json = html.slice(si + sOpen.length, se);
    try { checkData(JSON.parse(json), errors); }
    catch (e) { errors.push(`index.html, строка ${lineOf(html, si)}: JSON в app-state не читается — ${e.message}`); }
  }
  // 2) код приложения: от <script id="app-js"> до последнего </script> перед </body>
  // (внутри кода есть строки с "<script ...></script>", поэтому ищем именно последний)
  const jOpen = '<script id="app-js">';
  const ji = html.indexOf(jOpen);
  const body = html.lastIndexOf('</body>');
  const je = html.lastIndexOf('</script>', body < 0 ? html.length : body);
  if (ji < 0 || je < ji) errors.push('index.html: не найден <script id="app-js"> с кодом');
  else {
    const code = html.slice(ji + jOpen.length, je);
    // добавляем пустые строки, чтобы номера строк в ошибке совпадали с index.html
    checkJs('\n'.repeat(lineOf(html, ji) - 1) + code, 'index.html', errors);
  }
  // без config.js сайт потеряет сервер, без манифеста — установку на телефон
  const head = (html.match(/<head>([\s\S]*?)<\/head>/) || [])[1] || '';
  for (const must of ['config.js', 'manifest.webmanifest'])
    if (!head.includes(must)) errors.push(`index.html: в <head> нет "${must}"`);
  // 3) стили на месте
  if (!/<style id="app-css">[\s\S]*?<\/style>/.test(html)) errors.push('index.html: не найден <style id="app-css">');
}

const file = readInput();
if (!file || !fs.existsSync(file)) process.exit(0);
const ext = path.extname(file).toLowerCase();
const base = path.basename(file);
const text = fs.readFileSync(file, 'utf8');
const errors = [];

if (base === 'index.html') checkIndex(text, errors);
// код Cloudflare Worker (worker/) — тоже модуль
else if (ext === '.mjs' || (ext === '.js' && /(^|[\\/])worker[\\/]/.test(path.resolve(file)))) checkModule(file, base, errors);
else if (ext === '.js') checkJs(text, base, errors);
else if (ext === '.json' || ext === '.webmanifest') {
  try { JSON.parse(text); } catch (e) { errors.push(`${base}: JSON не читается — ${e.message}`); }
} else process.exit(0);

if (errors.length) {
  const shown = errors.slice(0, 30);
  console.error(`Проверка ${base}: найдено ошибок — ${errors.length}\n- ` + shown.join('\n- ') +
    (errors.length > shown.length ? `\n…и ещё ${errors.length - shown.length}` : ''));
  process.exit(2);
}
process.exit(0);
