import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Загрузка конфигурационного JS-файла (ES-модуль с default export).
 *
 * Если конфиг содержит секцию `type`, выбирается вложенный конфиг по `typeName`.
 * Если `typeName` не найден — используется `type.default`.
 * Если секции `type` нет — возвращается весь default export как есть.
 *
 * @param {string} configPath — абсолютный путь к конфигу
 * @param {string|null} typeName — имя типа (ключ из секции type)
 * @returns {Promise<object>}
 */
const loadConfig = async (configPath, typeName) => {
    const configUrl = pathToFileURL(configPath).href;
    const module = await import(configUrl);
    const raw = module.default;

    if (raw && typeof raw === "object" && raw.type) {
        const typeSection = raw.type;
        return typeSection[typeName] || typeSection.default || {};
    }

    return raw;
};

/**
 * Разбор аргументов командной строки.
 *
 * @param {string[]} argv
 * @returns {{mocksDir: string, configPath: string|null}}
 */
const parseArgs = (argv) => {
    const args = argv.slice(2);

    if (args.length < 1) {
        process.stderr.write("Ошибка: не указана папка моков\n\n");
        process.stderr.write("Пример запуска:\n");
        process.stderr.write("  node src/create-handlers-msw.js ./mocks/finvin-main -conf ./msw-har.config.js -type fin\n");
        process.exit(1);
    }

    const mocksDir = path.resolve(process.cwd(), args[0]);

    let configPath = null;
    const confIndex = args.indexOf("-conf");
    if (confIndex !== -1 && args[confIndex + 1]) {
        configPath = path.resolve(process.cwd(), args[confIndex + 1]);
    }

    let typeName = null;
    const typeIndex = args.indexOf("-type");
    if (typeIndex !== -1 && args[typeIndex + 1]) {
        typeName = args[typeIndex + 1];
    }

    return { mocksDir, configPath, typeName };
};

/**
 * Чтение и парсинг JSON-файла.
 *
 * @param {string} filePath
 * @returns {object|null}
 */
const readJsonFile = (filePath) => {
    try {
        const raw = fs.readFileSync(filePath, "utf8");
        return JSON.parse(raw);
    } catch {
        return null;
    }
};

/**
 * Проверка существования файла.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
const fileExists = (filePath) => {
    try {
        return fs.existsSync(filePath);
    } catch {
        return false;
    }
};

/**
 * Рекурсивное создание директории.
 *
 * @param {string} dirPath
 */
const ensureDir = (dirPath) => {
    fs.mkdirSync(dirPath, { recursive: true });
};

/**
 * Построение относительного пути к файлу ответа от корня папки моков.
 *
 * Для запросов без rpcMethod (fin):  `<fetchPath>/<method>/response-<type>-<index>.json`
 * Для запросов с rpcMethod (jrpc):   `<fetchPath>/<method>/<rpcMethod>/response-<type>-<index>.json`
 *
 * @param {object} entry — запись из calling-order.json
 * @param {boolean} isRpc — признак rpc-режима из конфига
 * @returns {string}
 */
const buildResponseRelPath = (entry, isRpc) => {
    const { fetchPath, fetchMethod, typeResponse, currentIndex, rpcMethod } = entry;

    const methodDir = fetchMethod === "get" ? "get" : "post";
    const typeSuffix = typeResponse === "error" ? "error" : "result";
    const fileName = `response-${typeSuffix}-${currentIndex}.json`;

    if (isRpc && rpcMethod) {
        return path.join(fetchPath, methodDir, rpcMethod, fileName);
    }

    return path.join(fetchPath, methodDir, fileName);
};

/**
 * Формирование инициализации state из конфига.
 *
 * @param {object} config
 * @returns {string} — строка-присваивание для объекта state
 */
const buildStateInit = (config) => {
    const stateEntries = config.state || [];
    const lines = stateEntries.map((entry) => {
        let value;

        if (entry.type === "rpcMethodTrigger") {
            // Для rpcMethodTrigger initial — само начальное значение (например false)
            value = entry.initial !== undefined ? entry.initial : false;
        } else {
            // Для path — initial это boolean-флаг, value содержит начальное значение
            if (entry.initial) {
                value = entry.value !== undefined ? entry.value : null;
            } else {
                value = null;
            }
        }

        return `    ${entry.name}: ${JSON.stringify(value)}`;
    });

    return `{\n${lines.join(",\n")}\n}`;
};

/**
 * Вычисление строки условия для записи (без учёта set_* полей).
 *
 * @param {object} entry — запись из calling-order.json
 * @param {object} config — конфигурация
 * @returns {string} — строка условия (например "body.method === \"getRates\"")
 */
const buildConditionStr = (entry, config) => {
    const { state: stateConditions, rpcMethod } = entry;
    const isRpc = Boolean(config.rpcMethod);

    const conditionParts = [];

    Object.entries(stateConditions || {}).forEach(([key, value]) => {
        if (key.startsWith("set_")) {
            return;
        }
        if (value === null) {
            conditionParts.push(`state.${key} === null`);
        } else {
            conditionParts.push(`state.${key} === ${JSON.stringify(value)}`);
        }
    });

    if (isRpc && rpcMethod) {
        conditionParts.push(`body.method === ${JSON.stringify(rpcMethod)}`);
    }

    return conditionParts.length > 0 ? conditionParts.join(" && ") : "true";
};

/**
 * Генерация условия для одной записи из calling-order.json.
 *
 * @param {object} entry — запись из calling-order.json
 * @param {object} config — конфигурация
 * @param {string} responseRelPath — относительный путь к json-файлу ответа
 * @returns {string} — код блока if (...) { ... }
 */
const buildConditionBlock = (entry, config, responseRelPath) => {
    const { state: stateConditions } = entry;

    const conditionStr = buildConditionStr(entry, config);

    // Команды изменения state (set_*)
    const setStateLines = [];
    Object.entries(stateConditions || {}).forEach(([key, value]) => {
        if (!key.startsWith("set_")) {
            return;
        }
        const stateKey = key.replace(/^set_/, "");
        const valueStr = value === null ? "null" : JSON.stringify(value);
        setStateLines.push(`            state.${stateKey} = ${valueStr};`);
    });

    const setBlock = setStateLines.length > 0 ? `\n${setStateLines.join("\n")}` : "";

    const raceCondition = config.checkRaceCondition;
    const delayLine = Array.isArray(raceCondition) && raceCondition.length === 2
        ? `\n            await new Promise(resolve => setTimeout(resolve, Math.random() * (${raceCondition[1] * 1000} - ${raceCondition[0] * 1000}) + ${raceCondition[0] * 1000}));`
        : "";

    const sessionCookie = Boolean(config.sessionCookie);
    const returnLine = sessionCookie
        ? "            return respond(json, sessionId);"
        : "            return HttpResponse.json(json);";

    return `        if (${conditionStr}) {
            const json = (await import(${JSON.stringify("./" + responseRelPath)}, { with: { type: "json" } })).default;${setBlock}${delayLine}

${returnLine}
        }`;
};

/**
 * Генерация кода одного обработчика (http.get / http.post).
 *
 * Группирует записи по (fetchMethod, fetchPath, rpcMethod).
 *
 * @param {Array} entries — записи из calling-order.json
 * @param {object} config — конфигурация
 * @param {string} mocksDir — абсолютный путь к папке моков
 * @returns {string} — код обработчика (например, http.post("/public_api/step/json", async (...) => { ... }))
 */
const buildHandler = (entries, config, mocksDir) => {
    const isRpc = Boolean(config.rpcMethod);
    const entryRequestUrl = config.entryRequestUrl;

    // Все записи имеют одинаковые fetchMethod, fetchPath и (если есть) rpcMethod
    const { fetchMethod, fetchPath } = entries[0];
    const rpcMethod = entries[0].rpcMethod;

    const httpMethod = fetchMethod === "get" ? "http.get" : "http.post";
    const routePath = path.join(entryRequestUrl, fetchPath).replace(/\\/g, "/");

    const sessionCookie = Boolean(config.sessionCookie);

    // Нужно ли читать body (для rpc-методов)
    const needsBody = isRpc && fetchMethod !== "get";

    // В режиме сессий всегда нужен request — для чтения cookie
    const bodyParam = needsBody || sessionCookie ? "{ request }" : "";

    const sessionLine = sessionCookie
        ? `        const { sessionId, state } = getSession(request);\n`
        : "";

    // Сортируем записи по order
    const sorted = [...entries].sort((a, b) => a.order - b.order);

    const conditionBlocks = sorted.map((entry) => {
        const responseRelPath = buildResponseRelPath(entry, isRpc);

        return buildConditionBlock(entry, config, responseRelPath);
    });

    // Проверка существования файлов ответов
    sorted.forEach((entry) => {
        const responseRelPath = buildResponseRelPath(entry, isRpc);
        const fullPath = path.join(mocksDir, responseRelPath);
        if (!fileExists(fullPath)) {
            process.stderr.write(`⚠ Файл ответа не найден: ${responseRelPath}\n`);
        }
    });

    const bodyParseLine = needsBody
        ? `        const body = await request.json();\n`
        : "";

    const handlerBody = `    ${httpMethod}(${JSON.stringify(routePath)}, async (${bodyParam}) => {
${sessionLine}${bodyParseLine}${conditionBlocks.join("\n")}
    })`;

    return handlerBody;
};

/**
 * Группировка записей calling-order по ключу обработчика.
 *
 * Для rpc-методов все запросы идут на один URL и различаются по body.method,
 * поэтому группируем только по `fetchMethod|fetchPath` — все rpc-запросы
 * попадают в один обработчик с if-цепочкой по body.method и state.
 *
 * Для обычных запросов (fin) rpcMethod отсутствует, группировка та же.
 *
 * @param {Array} callingOrder
 * @returns {Map<string, Array>}
 */
const groupEntriesByHandler = (callingOrder) => {
    const groups = new Map();

    callingOrder.forEach((entry) => {
        const key = `${entry.fetchMethod}|${entry.fetchPath}`;
        if (!groups.has(key)) {
            groups.set(key, []);
        }
        groups.get(key).push(entry);
    });

    return groups;
};

/**
 * Главная функция.
 */
const main = async () => {
    const { mocksDir, configPath, typeName } = parseArgs(process.argv);

    if (!configPath) {
        process.stderr.write("Ошибка: не указан конфигурационный файл (-conf)\n");
        process.exit(1);
    }

    const config = await loadConfig(configPath, typeName);

    const callingOrderPath = path.join(mocksDir, "calling-order.json");
    const callingOrder = readJsonFile(callingOrderPath);

    if (!callingOrder) {
        process.stderr.write(`Ошибка: не удалось прочитать ${callingOrderPath}\n`);
        process.exit(1);
    }

    const groups = groupEntriesByHandler(callingOrder);

    const isRpc = Boolean(config.rpcMethod);

    const handlers = [];
    groups.forEach((entries) => {
        handlers.push(buildHandler(entries, config, mocksDir));
    });

    const stateInit = buildStateInit(config);
    const sessionCookie = Boolean(config.sessionCookie);

    const header = sessionCookie
        ? `import { http, HttpResponse } from "msw"

const initialState = ${stateInit};

const sessions = new Map();

const getSession = (request) => {
    const sessionId = request.headers.get("x-mock-session") || crypto.randomUUID();
    if (!sessions.has(sessionId)) {
        sessions.set(sessionId, { ...initialState });
    }
    return { sessionId, state: sessions.get(sessionId) };
};

const respond = (json, sessionId) => HttpResponse.json(json, {
    headers: { "x-mock-session": sessionId }
});
`
        : `import { http, HttpResponse } from "msw"

const state = ${stateInit};
`;

    const output = `${header}
export const handlers = [
${handlers.join(",\n")}
]
`;

    const outputPath = path.join(mocksDir, "handlers.js");
    ensureDir(path.dirname(outputPath));
    fs.writeFileSync(outputPath, output, "utf8");

    process.stdout.write(`✓ Файл handlers.js создан: ${outputPath}\n`);
    process.stdout.write(`  Обработчиков сгенерировано: ${handlers.length}\n`);
};

main().catch((err) => {
    process.stderr.write(`Ошибка: ${err.message}\n`);
    process.exit(1);
});