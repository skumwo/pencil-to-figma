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

После выбора файлов внизу плагина четыре настройки:

- **Keep components** — компоненты Pencil (`reusable`) становятся компонентами Figma, а каждый экземпляр — связанным инстансом со своими оверрайдами (текст, цвета, кегль, обводки, видимость, отступы). Правишь компонент — меняются все его копии. По умолчанию ON. Выключено — как раньше, каждый экземпляр разворачивается в обычные слои. Для режима B: `node exporter/cli.mjs design.pen --components`.

- **Check 1:1 against Pencil** — после импорта каждый кадр рендерится в Figma и в Pencil и сравнивается (см. «Проверка 1:1» ниже). По умолчанию ON.

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

## Проверка 1:1

Импорт сам проверяет себя — смотреть глазами каждый раз не нужно.

1. **Раскладка.** Bridge передаёт вместе с дизайном итоговые размеры каждого узла так, как их посчитал Pencil (`_box`). После сборки каждого кадра плагин сверяет с ними свои слои и приводит текст к правилам Pencil:
   - **высота строки** — Pencil округляет каждую строку до целого пикселя (`round(кегль × интервал)`, а без интервала — по метрикам шрифта: Inter ×1,21, Manrope ×1,366). Figma ставит 122% без округления, а её «Auto» выше на ~2px; поэтому высота строки ставится в px ровно как у Pencil;
   - **переносы** — Pencil, как браузер, не считает пробел в конце строки, Figma считает. На таких переносах пробелу даётся нулевая ширина (он в конце строки и не виден), и строка ломается там же, где в Pencil;
   - **ширина надписей** — движки расходятся по ширине глифов на ~0,5%; однострочные надписи подгоняются трекингом (сотые доли px) под ширину Pencil, чтобы кнопки и строки таблиц совпадали по размеру;
   - **обводка текста** не переносится — Pencil её не рисует.
   Любое другое расхождение размеров попадает в отчёт.
2. **Рендер.** Плагин рендерит все импортированные кадры, bridge рендерит те же кадры из Pencil (начинает ещё во время импорта) и сравнивает попиксельно — с допуском на сглаживание и на дрейф конца строки внутри текстовых блоков, но не на пропавшие элементы, другие цвета, толщины или переносы.
3. **Итог** — прямо в плагине: сколько кадров совпало и какие нет. Всё остальное bridge кладёт в `~/.pencil-to-figma/verify/<время>/`: оба рендера каждого кадра, `— diff.png` с отмеченными областями расхождений и `report.json` (кадры, области, расхождения раскладки, журнал плагина: оверрайды, которые Figma не приняла, подмены шрифтов). Хранятся три последних прогона.

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

- **Импортируется только тот файл, который открыт в Pencil.** MCP-сервер — тонкий шим: он отдаёт документ из редактора и не умеет читать закрытые файлы (чтение с `filePath` неоткрытого файла просто висит до таймаута). Поэтому drop-зона плагина — это не «загрузи файл», а «укажи, какой из открытых файлов брать»: bridge спрашивает у Pencil путь активного документа, сверяет его с тем, что ты скинула, и **отказывается импортировать другой файл** вместо молчаливой подмены. Открой нужный `.pen` в Pencil перед импортом. Если подмена нужна осознанно — `PEN_ALLOW_MISMATCH=1 npm run bridge`.
- **Несохранённые правки попадут в импорт.** Pencil отдаёт своё in-memory состояние, а не то, что лежит на диске. Если имя совпало, а байты нет, bridge пишет об этом `NOTE` в лог.
- **Поддерживаются обе версии MCP-API Pencil.** Pen 1.2.x заменил `batch_get` / `get_variables` / `get_editor_state` / `export_nodes` одним `execute` + `get_app_state`; bridge и CLI сами определяют, какой API у установленной сборки (`exporter/lib/pencil-api.mjs`). На 1.2.10 Pencil держит несколько MCP-клиентов сразу, так что Claude Code с подключённым Pencil импорту не мешает.
- **Первый запрос к Pencil после подключения иногда висит ~60 с** и падает с `you are probably referencing the wrong .pen file` — даже для правильного файла. Bridge гасит это коротким прогревочным `get_app_state` (5 с) и повтором, так что в логе может мелькнуть `get_app_state attempt 1 failed` — это нормально.
- **Не каждый оверрайд Pencil бывает оверрайдом в Figma.** Figma не даёт сдвинуть или изменить размер слоя внутри инстанса («This property cannot be overridden in an instance»), а подмену иконки или целого слоя инстанс не выражает вовсе. Если слои экземпляра изменены пропорционально (логотип в 0,92×), плагин масштабирует весь инстанс и возвращает кегли, отступы и обводки к значениям Pencil — инстанс остаётся связанным. Если нет — экземпляр собирается отвязанным (обычными слоями, 1:1 с Pencil), причина — в итоговом сообщении и в `report.json`. Режим компонентов требует Pen 1.2+.
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
