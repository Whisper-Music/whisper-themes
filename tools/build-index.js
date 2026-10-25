#!/usr/bin/env node
// Собирает index.json — список тем для «Библиотеки тем» в Whisper Music.
//
//   node tools/build-index.js          — пересобрать index.json (и достать превью из тем, у которых его нет)
//   node tools/build-index.js --check  — только проверить, что index.json актуален (для CI)
//
// Что делает:
// * открывает каждую themes/<id>.wmt тем же разборщиком, что и приложение (tools/wmt.js — копия src/wmt.js);
// * проверяет: имя файла = manifest.id, id не совпадает со встроенными стилями, файл не больше 64 МБ;
// * превью: берёт previews/<id>.(jpg|jpeg|png|webp), а если его нет — достаёт картинку manifest.preview из темы;
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

const check = process.argv.includes("--check");
const fail = (msg) => { console.error("✗ " + msg); process.exitCode = 1; };

(async () => {
  let old = { themes: [] };
  try { old = JSON.parse(fs.readFileSync(INDEX, "utf8")); } catch {}
  const oldById = new Map((old.themes || []).map((t) => [t.id, t]));

  const files = fs.readdirSync(THEMES).filter((f) => f.endsWith(".wmt")).sort();
  const themes = [];
  for (const f of files) {
    const id = f.slice(0, -4);
    const bytes = new Uint8Array(fs.readFileSync(path.join(THEMES, f)));
    if (!WMT.ID_RE.test(id)) { fail(`${f}: имя файла должно быть как manifest.id (a–z, 0–9, «-»)`); continue; }
    if (BUILTIN.includes(id)) { fail(`${f}: id совпадает со встроенным стилем`); continue; }
    if (bytes.length > MAX) { fail(`${f}: больше 64 МБ`); continue; }
    let th;
    try { th = await WMT.open(bytes); } catch (e) { fail(`${f}: ${e.message}`); continue; }
    const m = th.manifest;
    if (m.id !== id) { fail(`${f}: manifest.id = «${m.id}», а файл называется «${id}.wmt»`); continue; }
    if (!th.css("whisper-music") && !th.tokens?.color) { fail(`${f}: нет ни CSS для whisper-music, ни цветов в tokens`); continue; }

    let preview = PV_EXT.map((e) => `previews/${id}.${e}`).find((p) => fs.existsSync(path.join(ROOT, p))) || "";
    if (!preview && m.preview) {
      const a = th.asset(m.preview);
      const ext = String(a?.name || "").split(".").pop().toLowerCase();
      if (a && PV_EXT.includes(ext)) {
        preview = `previews/${id}.${ext}`;
        if (!check) { fs.mkdirSync(PREVIEWS, { recursive: true }); fs.writeFileSync(path.join(ROOT, preview), a.bytes); }
      }
    }
    if (!preview) console.warn(`! ${f}: нет превью — карточка в библиотеке будет без картинки`);
    if (preview && fs.existsSync(path.join(ROOT, preview)) && fs.statSync(path.join(ROOT, preview)).size > 2 * 1024 * 1024)
      fail(`${preview}: больше 2 МБ`);

    themes.push({
      id,
      name: String(m.name || id),
      author: String(m.author || ""),
      description: String(m.description || ""),
      version: String(m.version || ""),
      base: BUILTIN.includes(m.base) ? m.base : "neon",
      file: `themes/${id}.wmt`,
      preview,
      size: bytes.length,
      tags: Array.isArray(oldById.get(id)?.tags) ? oldById.get(id).tags : [],
    });
  }
  themes.sort((a, b) => a.name.localeCompare(b.name, "ru"));
  const out = JSON.stringify({ format: 1, themes }, null, 2) + "\n";

  if (check) {
    const cur = fs.existsSync(INDEX) ? fs.readFileSync(INDEX, "utf8").replace(/\r\n/g, "\n") : "";
    if (cur !== out) fail("index.json не совпадает с темами — запусти node tools/build-index.js и закоммить результат");
    else if (!process.exitCode) console.log(`✓ index.json актуален: ${themes.length} тем`);
    return;
  }
  fs.writeFileSync(INDEX, out);
  console.log(`✓ index.json: ${themes.length} тем — ${themes.map((t) => t.id).join(", ")}`);
})();
