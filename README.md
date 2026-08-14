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
| `frame` / `rectangle` / `ellipse` / `line` / `polygon` / `text` / `path` | соответствующие SceneNode типы |
| `group` | frame без заливки и клипа, размер по bounding box детей |
| `icon` (`library` + `icon`) | **реальные редактируемые векторы** из исходного SVG набора |
| `note` / `prompt` / `context` | TextNode |
| `fill: image` (URL → base64) | `figma.createImage` + ImagePaint |
| `fill: color: $token` | резолвится в `#hex` до загрузки |
| `fill: gradient` (linear/radial/angular/diamond) | GradientPaint всех типов |
| `stroke` + `strokeWidth` (число или `{top,right,bottom,left}`) | strokes + strokeWeight + per-side weights |
| `strokeAlignment` (inner/center/outer), `strokeLinecap`, `strokeLinejoin` | strokeAlign / strokeCap / strokeJoin |
| `cornerRadius` (число или массив из 4 углов) | cornerRadius / topLeftRadius / … |
| `layout: vertical/horizontal` + padding + gap | layoutMode + padding + itemSpacing |
| `layout: none` | абсолютное позиционирование детей (x/y сохраняются) |
| `width`/`height`: `fill_container` / `fit_content` / число / `fit_content(100)` | `FILL` / `HUG` / `FIXED` sizing modes |
| `justifyContent` / `alignItems` (вкл. `space_between`, `space_around`) | primaryAxisAlignItems / counterAxisAlignItems |
| `textGrowth` (auto / fixed-width / fixed-width-height) | textAutoResize WIDTH_AND_HEIGHT / HEIGHT / NONE |
| `clip: true` | clipsContent |
| `enabled: false` | `visible = false` (в т.ч. «удаление» узла в инстансе) |
| `opacity`, `rotation`, `blendMode` | соответствующие свойства |
| `flipX` / `flipY` | зеркалирование (для икон и path — запекается в геометрию) |
| `effect`: `shadow` (`shadowType: inner/outer`), `blur`, `background_blur` | DROP_SHADOW / INNER_SHADOW / LAYER_BLUR / BACKGROUND_BLUR |
| `fillRule: evenodd` | сохраняется — внутренние контуры остаются дырками |
| `innerRadius` / `startAngle` / `sweepAngle` у ellipse | `arcData` (кольца, пироги, дуги) |
| `polygonCount` | `pointCount` |
| text: family / weight / style / size / letterSpacing / lineHeight / textAlign / underline / strikethrough | соответствующие свойства TextNode |
| `ref` (инстансы компонентов) | развёрнуты с overrides через `resolveInstances` |

### Иконки

Pencil-узел `icon` содержит только ссылку на глиф (`library` + `icon`), без геометрии.
Bridge находит исходный SVG в npm-наборе и отдаёт разметку плагину, который импортирует
её как **настоящие векторы Figma** (не PNG) и красит в цвет из `fill` узла.

Поддерживаются все библиотеки из схемы `.pen`:

| `library` | npm-пакет |
|---|---|
| `lucide` | `lucide-static` |
| `feather` | `feather-icons` |
| `phosphor` | `@phosphor-icons/core` (все веса: thin/light/regular/bold) |
| `Material Symbols Outlined` / `Rounded` / `Sharp` | `@material-symbols/svg-400` |

Если глиф не найден (незнакомая библиотека или опечатка в имени), bridge растеризует
его через Pencil в PNG как fallback, а имя пишет в лог: `[icons] no SVG for: …`.

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

- **Импортируется только тот файл, который открыт в Pencil.** MCP-сервер — тонкий шим: он отдаёт документ из редактора и не умеет читать закрытые файлы (`open_document` есть не во всех сборках, а `batch_get` с `filePath` на неоткрытый файл просто висит до таймаута). Поэтому drop-зона плагина — это не «загрузи файл», а «укажи, какой из открытых файлов брать»: bridge спрашивает у Pencil путь активного документа, сверяет его с тем, что ты скинула, и **отказывается импортировать другой файл** вместо молчаливой подмены. Открой нужный `.pen` в Pencil перед импортом. Если подмена нужна осознанно — `PEN_ALLOW_MISMATCH=1 npm run bridge`.
- **Несохранённые правки попадут в импорт.** Pencil отдаёт своё in-memory состояние, а не то, что лежит на диске. Если имя совпало, а байты нет, bridge пишет об этом `NOTE` в лог.
- **Один MCP клиент за раз** — если у тебя параллельно работает Claude Code с подключённым Pencil MCP, bridge может не получить ответ (`you are probably referencing the wrong .pen file`). Закрой Claude Code на время импорта или используй режим B (JSON).
- **Reusable components** разворачиваются inline через `resolveInstances`. Чтобы они стали отдельными Figma-компонентами после импорта, нужно вручную сконвертировать через **Create component** (плагин не делает auto-component, потому что Pencil может ререндерить ref-структуру с разными overrides).
- **Шрифты зависят от Figma, а не от плагина.** Плагин просит у Figma ровно ту гарнитуру и вес, что стоят в `.pen`. Если их нет — пробует альтернативные написания веса (`SemiBold` → `Semi Bold`), потом тот же шрифт в Regular, потом Inter Regular. **Любая подмена теперь не молчит:** в консоли плагина будет `Unbounded Bold → Inter Regular`, и в Figma появится уведомление. Google-шрифты (Nunito, Unbounded и т.п.) Figma обычно отдаёт сама, кастомные нужно ставить в систему.
- **`shader` и `mesh_gradient` переносятся картинкой, не вектором.** У Figma нет ни фрагментных шейдеров, ни сетчатых градиентов, поэтому bridge просит Pencil отрендерить такие узлы в PNG и вставляет его заливкой. Выглядит 1:1, но не редактируется. В логе: `[fills] N node(s) use fills Figma can't express`.
- **`connection` (коннекторы) переносятся пустым контейнером** — у Figma нет аналога в auto-layout.
- **Material Symbols — только вес 400.** Пакет весит ~90 МБ на вес, поэтому ставится один. `weight` у иконки округляется к ближайшему установленному. Нужен другой — поставь рядом: `npm i @material-symbols/svg-300`, bridge подхватит его автоматически.
- **`layout: none` + `space_around`** — у Figma нет распределения space-around, оно маппится в `SPACE_BETWEEN` (ближайшее из доступного).
- **Шрифты** должны быть установлены в Figma. Если семейства нет, плагин пробует альтернативные написания веса (`SemiBold` → `Semi Bold`) и в последнюю очередь падает на Inter Regular.
- **Большие документы импортируются целиком, но не мгновенно.** Дерево вытягивается пачками по 40 узлов, так что доска на ~6000 узлов — это несколько десятков запросов к Pencil. Прогресс виден в логе bridge (`…expanding <id>: N subtrees`). Если какая-то часть всё же не раскрылась, плагин скажет об этом явно — и в консоли, и уведомлением в Figma.

---

## License

MIT — fork, modify, share freely.
