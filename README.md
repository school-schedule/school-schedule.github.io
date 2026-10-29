# Skedy (formerly המערכת שלי)

A personal school timetable for 10th grade (שכבת י׳) students, live at **https://school-schedule.github.io/**.

Each student picks their class and groups once (math, English, majors, …) and from then on sees only their own lessons for the day, already updated with cancellations, room changes, tests and exams.

It combines the best of the two apps the school uses: **משוב** has a personal timetable but no changes, **שחף** has the changes but only a grade-wide timetable.

## Languages

Hebrew (default, right-to-left), English and Russian.

## How it works

- **GitHub Pages** serves the app: a single `index.html` (HTML, CSS and plain JavaScript, no build step, no frameworks), plus `sw.js` for push notifications and a PWA manifest.
- **Cloudflare Worker** (URL in `config.js`) stores the timetable, checks the editor code, publishes changes, keeps backups and sends push notifications. Its code is not in this repository.
- A student's choices are kept only in their own browser (`localStorage`). No accounts, no personal data.
- To know how many students use the app, the browser sends the server, at most once a day, a random device id (made once and kept in `localStorage`) and the chosen class. No names, no IP addresses are stored. Only editors see the totals.
- Editors log in with a code checked by the server and publish changes that every student sees right away.

## Making changes

- Every change to `main` goes through a **Pull Request** (no direct pushes). Merging to `main` deploys the site to all students immediately.
- Keep it simple: no npm, no bundlers, ES5-style JS, and every UI text in all three languages.
- Run the app locally with `python3 -m http.server 8000` and open http://localhost:8000.
- See `CLAUDE.md` for the code layout and data model.
