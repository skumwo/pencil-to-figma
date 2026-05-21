# pencil-to-figma

Импортирует дизайны из **[pencil.dev](https://pencil.dev)** в **Figma** один-в-один: с картинками, цветами, авто-лейаутом, шрифтами, компонентами и страницами.

Закрывает боли популярных плагинов:
- ✅ Картинки реально подтягиваются (встроены как base64, а не битые ссылки)
- ✅ Цветовые токены (`$violet`, `$pastel-blue` и т.п.) резолвятся в hex до загрузки в Figma
- ✅ Auto-layout, padding, gap, justify, align — переносятся как задумано в Pencil
- ✅ `fill_container` / `fit_content` / numeric size → корректные `FILL` / `HUG` / `FIXED`
- ✅ Компоненты (`ref` инстансы) разворачиваются с их override-контентом
- ✅ Footer, секции с auto-layout HUG content реально HUG-аются (а не висят на дефолтных 100px)
- ✅ Без лимитов — это твой локальный плагин, никакая Figma подписка не нужна

---

## Установка (10 минут)

### 1. Клонировать репо

```bash
git clone https://github.com/skumwo/pencil-to-figma.git
cd pencil-to-figma
```

### 2. Поставить зависимости и собрать плагин

```bash
npm install
npm run build
```

### 3. Подключить плагин в Figma

1. Открой Figma desktop (плагин работает только в десктопе, не в браузере).
2. **Plugins → Development → Import plugin from manifest…**
3. Выбери `plugin/manifest.json` из этой папки.
4. Плагин появится в меню **Plugins → Development → Pencil Import**.

Готово, плагин установлен локально.

---

## Использование

Есть **два режима** работы:

### Режим A — Drag&drop .pen + папка с картинками (главный)

Самый простой UX: перетаскиваешь файл и папку — плагин делает всё остальное.

#### Один раз: запусти bridge-сервер

В терминале:

```bash
cd pencil-to-figma
npm run bridge
```

Окно терминала держи открытым — это локальный мост между Pencil и Figma. Работает на `localhost:7777`.

> **Важно:** Pencil desktop приложение должно быть открыто, и нужный `.pen` файл — открыт в нём. Это потому что Pencil MCP подключается к десктопному приложению через сокет.

#### Каждый раз: импорт в Figma

1. В Pencil открой нужный `.pen` файл (двойным кликом по файлу или File → Open).
2. В Figma запусти **Plugins → Development → Pencil Import**.
3. В шапке плагина увидишь `Bridge: online` (зелёный).
4. Вкладка **"Drop .pen + images"** — перетащи `.pen` файл и папку с картинками в drop-зону (или используй кнопки `Pick .pen file` / `Pick images folder`).
5. Жми **Process & Import**.

Дизайн появится на canvas через несколько секунд.

### Режим B — Drop готовый design.json

Если хочется обойтись без bridge — можно один раз экспортировать `.pen` в JSON, и потом дропать JSON в плагин когда угодно (даже без открытого Pencil).

JSON экспортируется через **Claude Code** с подключённым Pencil MCP — slash-команда `/pen-export`:

```
/pen-export /path/to/design.pen
```

(slash-команда лежит в `.claude/commands/pen-export.md`)

Результат — файл `design.json` рядом с `.pen`. В плагине переключаешься на вкладку **"Drop design.json"** и дропаешь его.

---

## Опции плагина

После выбора файлов внизу плагина две настройки:

- **Wrap everything in one frame** — обернуть импорт в один контейнер-фрейм "Pencil Import". По умолчанию OFF, страницы появляются прямо на canvas как самостоятельные фреймы.

- **Scroll viewport to the import** — после импорта Figma автоматически скроллит к новым страницам, чтобы их сразу видеть. По умолчанию ON.

---

## Что переносится 1:1

| Свойство Pencil | Figma |
|---|---|
| `frame` / `rectangle` / `ellipse` / `line` / `text` / `vector` | соответствующие SceneNode типы |
| `fill: image` (URL → base64) | `figma.createImage` + ImagePaint |
| `fill: color: $token` | резолвится в `#hex` до загрузки |
| `fill: gradient` (linear/radial/angular/diamond) | GradientPaint всех типов |
| `stroke` (thickness, alignment) | strokes + strokeWeight + strokeAlign |
| `cornerRadius` (число или массив из 4 углов) | cornerRadius / topLeftRadius / … |
| `layout: vertical/horizontal/none` + padding + gap | layoutMode + padding + itemSpacing |
| `primaryAxisSize/counterAxisSize` (`fill_container` / `fit_content` / number) | `FILL` / `HUG` / `FIXED` sizing modes |
| `justifyContent` / `alignItems` | primaryAxisAlignItems / counterAxisAlignItems |
| `clip: true` | clipsContent |
| `opacity`, `rotation`, `visible`, `blendMode` | соответствующие свойства |
| `effects` (drop_shadow / inner_shadow / blur) | DROP_SHADOW / INNER_SHADOW / LAYER_BLUR |
| text: family / weight / size / letterSpacing / lineHeight / textAlign / textCase | соответствующие свойства TextNode |
| `ref` (инстансы компонентов) | развёрнуты с overrides через `resolveInstances` |

---

## Структура проекта

```
pencil-to-figma/
├── plugin/                  Figma плагин (TypeScript)
│   ├── manifest.json
│   ├── src/
│   │   ├── code.ts          Главный билдер: Pencil tree → Figma nodes
│   │   └── ui.html          UI плагина (две вкладки + drop-зоны)
│   ├── build.mjs            esbuild конфиг
│   └── dist/                Собранный JS+HTML (создаётся при build)
│
├── bridge/                  Локальный HTTP-сервер (Режим A)
│   └── server.mjs           localhost:7777 — спавнит Pencil MCP, отдаёт design JSON
│
├── exporter/                Standalone Node CLI (Режим B и батч-импорты)
│   ├── cli.mjs              node exporter/cli.mjs design.pen → design.json
│   ├── process.mjs          post-processor для готовых snapshot JSON
│   └── lib/
│       ├── mcp-client.mjs   JSON-RPC stdio клиент для Pencil MCP
│       ├── resolve-tokens.mjs   $token → #hex
│       └── embed-images.mjs     картинки → base64
│
└── .claude/
    └── commands/
        └── pen-export.md    Slash-команда /pen-export для Claude Code
```

---

## Разработка

Если хочешь что-то поправить в плагине:

```bash
npm run watch
```

esbuild будет ребилдить `dist/` при каждом изменении в `plugin/src/`. В Figma после ребилда:
- ПКМ на плагине в `Plugins → Development → Pencil Import` → **Reload plugin**
- Или закрыть-открыть окно плагина

Полезные scripts:

| Команда | Что делает |
|---|---|
| `npm run build` | Собрать плагин один раз |
| `npm run watch` | Ребилд на лету |
| `npm run bridge` | Запустить bridge-сервер на localhost:7777 |
| `npm run export` | CLI экспортер `.pen → design.json` |

---

## Известные ограничения

- **Pencil desktop должен быть открыт** для режима A — MCP-сервер это тонкий шим, реальную работу с `.pen` файлом делает само приложение.
- **Один MCP клиент за раз** — если у тебя параллельно работает Claude Code с подключённым Pencil MCP, bridge может не получить ответ. Закрой Claude Code на время импорта или используй режим B (JSON).
- **Reusable components** разворачиваются inline через `resolveInstances`. Чтобы они стали отдельными Figma-компонентами после импорта, нужно вручную сконвертировать через **Create component** (плагин не делает auto-component, потому что Pencil может ререндерить ref-структуру с разными overrides).

---

## License

MIT — fork, modify, share freely.
