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
        process.stderr.write("  node src/reduplicates.js ./mocks/finvin-main -conf ./msw-har.config.js -type fin\n");
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
 * Рекурсивное создание директории.
 *
 * @param {string} dirPath
 */
const ensureDir = (dirPath) => {
    fs.mkdirSync(dirPath, { recursive: true });
};

/**
 * Запись JSON в файл с красивым форматированием.
 *
 * @param {string} filePath
 * @param {object} data
 */
const writeJsonFile = (filePath, data) => {
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, JSON.stringify(data, null, 4) + "\n", "utf8");
};

/**
 * Удаление файла, если он существует.
 *
 * @param {string} filePath
 */
const removeFile = (filePath) => {
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    }
};

/**
 * Нормализация тела запроса/ответа: удаляет поле `id` (json-rpc идентификатор запроса),
 * если включён режим rpcMethod.
 *
 * @param {*} data
 * @param {boolean} rpcMethod
 * @returns {*}
 */
const normalizeData = (data, rpcMethod) => {
    if (!rpcMethod || data === null || typeof data !== "object") {
        return data;
    }

    if (Array.isArray(data)) {
        return data.map((item) => normalizeData(item, rpcMethod));
    }

    const result = {};
    Object.keys(data).forEach((key) => {
        if (key === "id") {
            return;
        }
        result[key] = normalizeData(data[key], rpcMethod);
    });
    return result;
};

/**
 * Ключ группы для записи calling-order (fetchPath/fetchMethod[/rpcMethod]).
 *
 * @param {object} entry
 * @returns {string}
 */
const groupKey = (entry) => {
    const parts = [entry.fetchPath, entry.fetchMethod];
    if (entry.rpcMethod) {
        parts.push(entry.rpcMethod);
    }
    return parts.join("/");
};

/**
 * Путь к директории группы внутри папки моков.
 *
 * @param {string} mocksDir
 * @param {object} entry
 * @returns {string}
 */
const groupDir = (mocksDir, entry) => {
    const parts = [mocksDir, entry.fetchPath, entry.fetchMethod];
    if (entry.rpcMethod) {
        parts.push(entry.rpcMethod);
    }
    return path.join(...parts);
};

/**
 * Имя файла запроса по индексу.
 *
 * @param {number} index
 * @returns {string}
 */
const requestFileName = (index) => `request-${index}.json`;

/**
 * Имя файла ответа по типу и индексу.
 *
 * @param {string} typeResponse
 * @param {number} index
 * @returns {string}
 */
const responseFileName = (typeResponse, index) => `response-${typeResponse}-${index}.json`;

/**
 * Основная функция скрипта.
 */
const main = async () => {
    const { mocksDir, configPath, typeName } = parseArgs(process.argv);

    if (!fs.existsSync(mocksDir) || !fs.statSync(mocksDir).isDirectory()) {
        console.error(`Ошибка: директория моков не найдена: ${mocksDir}`);
        process.exit(1);
    }

    let rpcMethod = false;
    if (configPath) {
        if (!fs.existsSync(configPath)) {
            console.error(`Ошибка: файл конфигурации не найден: ${configPath}`);
            process.exit(1);
        }
        const config = await loadConfig(configPath, typeName);
        rpcMethod = Boolean(config.rpcMethod);
    }

    const callingOrderFile = path.join(mocksDir, "calling-order.json");
    const callingOrder = readJsonFile(callingOrderFile);
    if (!Array.isArray(callingOrder)) {
        console.error(`Ошибка: calling-order.json не найден или некорректен: ${callingOrderFile}`);
        process.exit(1);
    }

    // Дедупликация файлов: оставляем только canonical (первый экземпляр
    // уникальной пары request/response), остальные файлы удаляем.
    // Но в calling-order.json ВСЕ записи сохраняются — дубликаты merely
    // перенаправляются (currentIndex + typeResponse) на canonical файл.
    // Это гарантирует что set_* поля в state никогда не теряются.
    const seenKeys = {};
    const canonicalByKey = {};
    let removedFiles = 0;

    callingOrder.forEach((entry) => {
        const key = groupKey(entry);
        const dir = groupDir(mocksDir, entry);
        const reqFile = path.join(dir, requestFileName(entry.currentIndex));
        const resFile = path.join(dir, responseFileName(entry.typeResponse, entry.currentIndex));

        const request = readJsonFile(reqFile);
        const response = readJsonFile(resFile);

        const normRequest = normalizeData(request, rpcMethod);
        const normResponse = normalizeData(response, rpcMethod);

        const dedupKey = JSON.stringify(normRequest) + "\u0000" + JSON.stringify(normResponse);
        const canonicalKey = key + "\u0000" + dedupKey;

        if (!seenKeys[key]) {
            seenKeys[key] = new Set();
        }

        if (!seenKeys[key].has(dedupKey)) {
            // Первый экземпляр — canonical, файл оставляем
            seenKeys[key].add(dedupKey);
            canonicalByKey[canonicalKey] = {
                request,
                response,
                oldIndex: entry.currentIndex,
                typeResponse: entry.typeResponse,
            };
        } else {
            // Дубликат — файл удаляем, запись в calling-order перенаправляем
            removeFile(reqFile);
            removeFile(resFile);
            removedFiles += 1;

            const canonical = canonicalByKey[canonicalKey];
            entry.currentIndex = canonical.oldIndex;
            entry.typeResponse = canonical.typeResponse;
        }
    });

    // Перенумерация canonical файлов внутри каждой группы (1, 2, 3, ...)
    // и обновление currentIndex во всех записях (canonical и дубликатов).
    // После перенаправления дубликаты указывают на тот же oldIndex что и canonical,
    // поэтому по oldIndex можно найти canonical данные.
    const newIndexCounters = {};
    const oldToNewIndex = {};

    callingOrder.forEach((entry) => {
        const key = groupKey(entry);
        const oldIndex = entry.currentIndex;
        const typeResponse = entry.typeResponse;
        const remapKey = key + "\u0000" + oldIndex + "\u0000" + typeResponse;

        if (oldToNewIndex[remapKey] !== undefined) {
            // Уже перенумерован — просто ставим новый индекс
            entry.currentIndex = oldToNewIndex[remapKey];
            return;
        }

        // Новый canonical индекс
        if (!newIndexCounters[key]) {
            newIndexCounters[key] = 0;
        }
        newIndexCounters[key] += 1;
        const newIndex = newIndexCounters[key];

        const dir = groupDir(mocksDir, entry);

        // Удаляем старые файлы, если индекс изменился
        if (oldIndex !== newIndex) {
            removeFile(path.join(dir, requestFileName(oldIndex)));
            removeFile(path.join(dir, responseFileName(typeResponse, oldIndex)));
        }

        // Записываем canonical файл под новым индексом
        const canonicalKey = Object.keys(canonicalByKey).find((ck) => {
            const c = canonicalByKey[ck];
            return c.oldIndex === oldIndex && c.typeResponse === typeResponse && ck.startsWith(key + "\u0000");
        });
        const canonical = canonicalKey ? canonicalByKey[canonicalKey] : null;

        if (canonical) {
            writeJsonFile(path.join(dir, requestFileName(newIndex)), canonical.request);
            writeJsonFile(path.join(dir, responseFileName(typeResponse, newIndex)), canonical.response);
        }

        entry.currentIndex = newIndex;
        oldToNewIndex[remapKey] = newIndex;
    });

    // Дополнительная дедупликация: среди записей с одинаковым условием
    // (rpcMethod + state без учёта set_*-полей) и одинаковым файлом ответа
    // (groupKey + currentIndex + typeResponse) удаляем записи без set_*-полей,
    // если в группе есть запись с set_*-полями. Это убирает "тупиковые" записи,
    // которые возвращают тот же ответ, но не переводят состояние, и потому
    // затеняют запись с переходом состояния в if-цепочке handlers.js.
    const conditionKey = (entry) => {
        const nonSetState = {};
        Object.entries(entry.state || {}).forEach(([key, value]) => {
            if (!key.startsWith("set_")) {
                nonSetState[key] = value;
            }
        });
        return JSON.stringify({
            fetchPath: entry.fetchPath,
            fetchMethod: entry.fetchMethod,
            rpcMethod: entry.rpcMethod || null,
            state: nonSetState,
            currentIndex: entry.currentIndex,
            typeResponse: entry.typeResponse,
        });
    };

    const hasSetFields = (entry) =>
        Object.keys(entry.state || {}).some((key) => key.startsWith("set_"));

    const groupHasSet = {};
    callingOrder.forEach((entry) => {
        const cKey = conditionKey(entry);
        if (hasSetFields(entry)) {
            groupHasSet[cKey] = true;
        }
    });

    const preferSetCallingOrder = [];
    let removedNoSet = 0;
    callingOrder.forEach((entry) => {
        const cKey = conditionKey(entry);
        if (groupHasSet[cKey] && !hasSetFields(entry)) {
            removedNoSet += 1;
            return;
        }
        preferSetCallingOrder.push(entry);
    });

    // Дедупликация записей в calling-order.json: удаляем объекты, у которых
    // совпадают все поля кроме `order`, не меняя порядка оставшихся.
    // После удаления перегенерируем значения `order` (1, 2, 3, ...).
    const entryKey = (entry) => {
        const copy = {};
        Object.keys(entry).forEach((key) => {
            if (key !== "order") {
                copy[key] = entry[key];
            }
        });
        return JSON.stringify(copy);
    };

    const seenEntries = new Set();
    const dedupedCallingOrder = [];
    let removedEntries = 0;

    preferSetCallingOrder.forEach((entry) => {
        const key = entryKey(entry);
        if (seenEntries.has(key)) {
            removedEntries += 1;
            return;
        }
        seenEntries.add(key);
        dedupedCallingOrder.push(entry);
    });

    dedupedCallingOrder.forEach((entry, index) => {
        entry.order = index + 1;
    });

    // Финальная очистка state: если запись уникальна по ключу без учёта
    // order, currentIndex и state, то условие по state в handler не нужно —
    // удаляем не-set поля из state (например "status": "passport"),
    // оставляя только set_* поля. Если set_* полей нет — удаляем state entirely.
    const statelessKey = (entry) => {
        const copy = {};
        Object.keys(entry).forEach((key) => {
            if (key !== "order" && key !== "currentIndex" && key !== "state") {
                copy[key] = entry[key];
            }
        });
        return JSON.stringify(copy);
    };

    const statelessCounts = {};
    dedupedCallingOrder.forEach((entry) => {
        const sKey = statelessKey(entry);
        statelessCounts[sKey] = (statelessCounts[sKey] || 0) + 1;
    });

    let cleanedState = 0;
    dedupedCallingOrder.forEach((entry) => {
        const sKey = statelessKey(entry);
        if (statelessCounts[sKey] === 1 && entry.state) {
            const newState = {};
            Object.entries(entry.state).forEach(([key, value]) => {
                if (key.startsWith("set_")) {
                    newState[key] = value;
                }
            });
            if (Object.keys(newState).length < Object.keys(entry.state).length) {
                cleanedState += 1;
            }
            if (Object.keys(newState).length > 0) {
                entry.state = newState;
            } else {
                delete entry.state;
            }
        }
    });

    // Запись calling-order.json
    writeJsonFile(callingOrderFile, dedupedCallingOrder);

    // Количество уникальных пар — это число canonical файлов (групп),
    // оставшихся после перенумерации, а не разница записей и удалённых файлов
    const canonicalCount = Object.values(newIndexCounters).reduce(
        (sum, count) => sum + count,
        0
    );

    console.log("=== Готово ===");
    console.log(`всего записей: ${dedupedCallingOrder.length}`);
    console.log(`уникальных пар: ${canonicalCount}`);
    console.log(`перенаправлено пар: ${removedFiles}`);
    console.log(`удалено дубликатов записей: ${removedEntries}`);
    console.log(`удалено записей без set_*: ${removedNoSet}`);
    console.log(`очищено state (не-set поля): ${cleanedState}`);
};

main().catch((error) => {
    console.error(`Ошибка: ${error.message}`);
    process.exit(1);
});