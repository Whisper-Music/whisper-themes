#!/usr/bin/env node
// Собирает index.json — список тем для «Библиотеки тем» в Whisper Music.
//
//   node tools/build-index.js          — пересобрать index.json (и достать превью из тем, у которых его нет)
//   node tools/build-index.js --check  — только проверить, что index.json актуален (для CI)
//
// Темы лежат по папкам-категориям (в приложении это папки библиотеки):
//   themes/whisper/<id>.wmt    — темы Whisper Music
//   themes/community/<id>.wmt  — темы пользователей
//   themes/artists/<id>.wmt    — темы в стиле конкретного артиста (manifest.artist — имя артиста)
// Превью — previews/<категория>/<id>.(jpg|jpeg|png|webp).
//
// Что делает:
// * открывает каждую тему тем же разборщиком, что и приложение (tools/wmt.js — копия src/wmt.js);
// * проверяет: имя файла = manifest.id, id не совпадает со встроенными стилями и не повторяется
//   в разных папках (приложение различает темы только по id), файл не больше 64 МБ;
// * категория — по папке: её не нужно писать в самой теме;
// * превью: берёт previews/<категория>/<id>.*, а если его нет — достаёт картинку manifest.preview из темы;
// * артист: manifest.artist, а если в теме его нет — то, что дописано руками в index.json;
// * теги (tags) хранятся только в index.json — их скрипт сохраняет при пересборке.
// Название, автор, описание, версия и основа берутся из manifest темы — правь их в самой теме.

const fs = require("fs");
const path = require("path");
const WMT = require("./wmt.js");

const ROOT = path.join(__dirname, "..");
const THEMES = path.join(ROOT, "themes");
const PREVIEWS = path.join(ROOT, "previews");
const INDEX = path.join(ROOT, "index.json");
const BUILTIN = ["neon", "royal", "steam", "lolitta"];
const PV_EXT = ["jpg", "jpeg", "png", "webp"];
const MAX = 64 * 1024 * 1024;
// Папки библиотеки — в этом порядке их показывает приложение. Новую папку нужно добавить и в приложение
// (src-tauri/src/themelib.rs → CATEGORIES и src/themelib.js → CATS): других путей оно не скачает.
const CATEGORIES = [
  { id: "whisper", name: "Whisper Music", description: "Темы от автора приложения" },
  { id: "community", name: "Пользователи", description: "Темы, которые прислали пользователи" },
  { id: "artists", name: "По артистам", description: "Темы в стиле конкретного исполнителя" },
];
const CAT_IDS = CATEGORIES.map((c) => c.id);

const check = process.argv.includes("--check");
const fail = (msg) => { console.error("✗ " + msg); process.exitCode = 1; };
const rel = (...p) => p.join("/");

(async () => {
  let old = { themes: [] };
  try { old = JSON.parse(fs.readFileSync(INDEX, "utf8")); } catch {}
  const oldById = new Map((old.themes || []).map((t) => [t.id, t]));

  // всё, что лежит в themes/ не по папкам, — ошибка: приложение такие файлы не увидит
  for (const e of fs.readdirSync(THEMES, { withFileTypes: true })) {
    if (e.isDirectory() && CAT_IDS.includes(e.name)) continue;
    if (e.name.startsWith(".")) continue;
    fail(`themes/${e.name}: темы кладутся в папки ${CAT_IDS.map((c) => `themes/${c}/`).join(", ")}`);
  }

  const themes = [], seen = new Map();
  for (const cat of CAT_IDS) {
    const dir = path.join(THEMES, cat);
    if (!fs.existsSync(dir)) continue;
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const f = rel("themes", cat, e.name);
      if (e.name.startsWith(".")) continue;
      if (!e.isFile() || !e.name.endsWith(".wmt")) { fail(`${f}: в папке категории — только файлы .wmt, без вложенных папок`); continue; }
      const id = e.name.slice(0, -4);
      if (!WMT.ID_RE.test(id)) { fail(`${f}: имя файла должно быть как manifest.id (a–z, 0–9, «-»)`); continue; }
      if (BUILTIN.includes(id)) { fail(`${f}: id совпадает со встроенным стилем`); continue; }
      if (seen.has(id)) { fail(`${f}: тема с id «${id}» уже есть в ${seen.get(id)} — id должны быть разными во всех папках`); continue; }
      seen.set(id, f);
      const bytes = new Uint8Array(fs.readFileSync(path.join(dir, e.name)));
      if (bytes.length > MAX) { fail(`${f}: больше 64 МБ`); continue; }
      let th;
      try { th = await WMT.open(bytes); } catch (err) { fail(`${f}: ${err.message}`); continue; }
      const m = th.manifest;
      if (m.id !== id) { fail(`${f}: manifest.id = «${m.id}», а файл называется «${id}.wmt»`); continue; }
      if (!th.css("whisper-music") && !th.tokens?.color) { fail(`${f}: нет ни CSS для whisper-music, ни цветов в tokens`); continue; }

      let preview = PV_EXT.map((x) => rel("previews", cat, `${id}.${x}`)).find((p) => fs.existsSync(path.join(ROOT, p))) || "";
      if (!preview && m.preview) {
        const a = th.asset(m.preview);
        const ext = String(a?.name || "").split(".").pop().toLowerCase();
        if (a && PV_EXT.includes(ext)) {
          preview = rel("previews", cat, `${id}.${ext}`);
          if (!check) { fs.mkdirSync(path.join(PREVIEWS, cat), { recursive: true }); fs.writeFileSync(path.join(ROOT, preview), a.bytes); }
        }
      }
      if (!preview) console.warn(`! ${f}: нет превью — карточка в библиотеке будет без картинки`);
      if (preview && fs.existsSync(path.join(ROOT, preview)) && fs.statSync(path.join(ROOT, preview)).size > 2 * 1024 * 1024)
        fail(`${preview}: больше 2 МБ`);

      const prev = oldById.get(id);
      const artist = typeof m.artist === "string" && m.artist.trim() ? m.artist.trim() : typeof prev?.artist === "string" ? prev.artist : "";
      if (cat === "artists" && !artist) console.warn(`! ${f}: не указан артист — добавь "artist": "…" в manifest темы`);

      themes.push({
        id,
        category: cat,
        name: String(m.name || id),
        author: String(m.author || ""),
        ...(cat === "artists" || artist ? { artist } : {}),
        description: String(m.description || ""),
        version: String(m.version || ""),
        base: BUILTIN.includes(m.base) ? m.base : "neon",
        file: rel("themes", cat, `${id}.wmt`),
        preview,
        size: bytes.length,
        tags: Array.isArray(prev?.tags) ? prev.tags : [],
      });
    }
  }
  const order = (t) => CAT_IDS.indexOf(t.category);
  themes.sort((a, b) => order(a) - order(b) || (a.artist || "").localeCompare(b.artist || "", "ru") || a.name.localeCompare(b.name, "ru"));
  // format 2: темы по папкам. Приложения, которые знают только format 1, покажут «обнови приложение».
  const out = JSON.stringify({ format: 2, categories: CATEGORIES, themes }, null, 2) + "\n";

  if (check) {
    const cur = fs.existsSync(INDEX) ? fs.readFileSync(INDEX, "utf8").replace(/\r\n/g, "\n") : "";
    if (cur !== out) fail("index.json не совпадает с темами — запусти node tools/build-index.js и закоммить результат");
    else if (!process.exitCode) console.log(`✓ index.json актуален: ${themes.length} тем`);
    return;
  }
  if (process.exitCode) { console.error("index.json не обновлён: сначала исправь ошибки выше"); return; }
  fs.writeFileSync(INDEX, out);
  const by = CAT_IDS.map((c) => `${c}: ${themes.filter((t) => t.category === c).length}`).join(", ");
  console.log(`✓ index.json: ${themes.length} тем (${by})`);
})();
