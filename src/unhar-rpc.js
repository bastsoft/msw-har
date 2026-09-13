import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Извлечение пути fetchPath из URL относительно entryRequestUrl.
 *
 * @param {string} url — полный URL запроса
 * @param {string} entryRequestUrl — базовый путь из конфига (например "/public_api" или "/rpc")
 * @returns {string} — путь после entryRequestUrl без ведущего слеша и без query string
 */
const extractFetchPath = (url, entryRequestUrl) => {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;

    const baseIndex = pathname.indexOf(entryRequestUrl);
    if (baseIndex === -1) {
        return pathname.replace(/^\//, "");
    }

    const afterBase = pathname.slice(baseIndex + entryRequestUrl.length);
    return afterBase.replace(/^\//, "");
};

/**
 * Безопасный парсинг JSON-строки.
 *
 * @param {string|undefined} text
 * @returns {object|null}
 */
const parseJson = (text) => {
    if (!text) {
        return null;
    }
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
};

/**
 * Извлечение значения по dot-нотации пути из объекта.
 *
 * @param {object|null} obj — исходный объект
 * @param {string} dotPath — путь вида "result.data.loan_application.status"
 * @returns {*} — значение по пути или undefined, если путь не существует
 */
const getValueByPath = (obj, dotPath) => {
    if (!obj || typeof obj !== "object" || !dotPath) {
        return undefined;
    }

    const segments = dotPath.split(".");
    let current = obj;

    segments.forEach((segment) => {
        if (current === null || current === undefined || typeof current !== "object") {
            current = undefined;
            return;
        }
        current = current[segment];
    });

    return current;
};

/**
 * Нормализация конфигурации состояний в единый массив описаний.
 *
 * Параметр `state` — массив объектов:
 *   { name: "status", type: "path", path: "result.data.loan_application.status" }
 *   { name: "auth", type: "rpcMethodTrigger", rpcMethod: "auth", value: true, initial: false }
 *
 * @param {object} config
 * @returns {Array<{name: string, type: string, path?: string, rpcMethod?: string, value: *, initial: *}>}
 */
const normalizeStates = (config) => {
    if (!Array.isArray(config.state)) {
        return [];
    }

    return config.state.map((stateConfig) => ({
        name: stateConfig.name,
        type: stateConfig.type,
        path: stateConfig.path,
        rpcMethod: stateConfig.rpcMethod,
        value: stateConfig.value ?? true,
        initial: stateConfig.initial ?? false,
        nullCheckMethods: stateConfig.nullCheckMethods ?? null,
    }));
};

/**
 * Определение типа ответа (typeResponse) по содержимому JSON-RPC ответа.
 *
 * @param {object|null} responseJson
 * @returns {string} — "result" или "error"
 */
const detectTypeResponse = (responseJson) => {
    if (responseJson && typeof responseJson === "object" && "error" in responseJson) {
        return "error";
    }
    return "result";
};

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
 * @returns {{harPath: string, configPath: string}}
 */
const parseArgs = (argv) => {
    const args = argv.slice(2);

    if (args.length < 1) {
        process.stderr.write("Ошибка: не указан HAR-файл\n\n");
        process.stderr.write("Пример запуска:\n");
        process.stderr.write("  node src/unhar-rpc.js ./source/finvin-main.har -conf ./msw-har.config.js -type fin\n");
        process.exit(1);
    }

    const harPath = path.resolve(args[0]);

    let configPath = null;
    const confIndex = args.indexOf("-conf");
    if (confIndex !== -1 && args[confIndex + 1]) {
        configPath = path.resolve(args[confIndex + 1]);
    }

    if (!configPath) {
        process.stderr.write("Ошибка: не указан файл конфигурации (-conf)\n\n");
        process.stderr.write("Пример запуска:\n");
        process.stderr.write("  node src/unhar-rpc.js ./source/finvin-main.har -conf ./msw-har.config.js -type fin\n");
        process.exit(1);
    }

    let typeName = null;
    const typeIndex = args.indexOf("-type");
    if (typeIndex !== -1 && args[typeIndex + 1]) {
        typeName = args[typeIndex + 1];
    }

    let mocksDir = null;
    const mocksDirIndex = args.indexOf("-mocks-dir");
    if (mocksDirIndex !== -1 && args[mocksDirIndex + 1]) {
        mocksDir = path.resolve(args[mocksDirIndex + 1]);
    }

    return { harPath, configPath, typeName, mocksDir };
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
 * Основная функция скрипта.
 */
const main = async () => {
    const { harPath, configPath, typeName, mocksDir } = parseArgs(process.argv);

    if (!fs.existsSync(harPath)) {
        process.stderr.write(`Ошибка: HAR-файл не найден: ${harPath}\n`);
        process.exit(1);
    }

    if (!fs.existsSync(configPath)) {
        process.stderr.write(`Ошибка: файл конфигурации не найден: ${configPath}\n`);
        process.exit(1);
    }

    const config = await loadConfig(configPath, typeName);
    const { entryRequestUrl, rpcMethod } = config;
    const states = normalizeStates(config);

    if (!entryRequestUrl) {
        process.stderr.write("Ошибка: в конфиге не указано поле entryRequestUrl\n");
        process.exit(1);
    }

    const harRaw = fs.readFileSync(harPath, "utf8");
    const har = JSON.parse(harRaw);

    const harBasename = path.basename(harPath, ".har");
    const mocksRoot = mocksDir || path.resolve("mocks", harBasename);

    const entries = har.log.entries || [];

    // Фильтрация: только xhr/fetch и url содержит entryRequestUrl
    const filteredEntries = entries.filter((entry) => {
        const resourceType = entry._resourceType;
        if (resourceType !== "xhr" && resourceType !== "fetch") {
            return false;
        }

        const url = entry.request?.url || "";
        return url.includes(entryRequestUrl);
    });

    // Счётчик индексов для каждой комбинации fetchPath + fetchMethod
    const indexCounters = {};
    const callingOrder = [];
    let order = 0;

    // Сквозное состояние — инициализируется начальными значениями из конфига.
    // Каждая запись в calling-order получает полную копию currentState,
    // что позволяет разводить дубликаты условий без счётчиков вызовов.
    const currentState = {};
    states.forEach((stateConfig) => {
        if (stateConfig.type === "path") {
            currentState[stateConfig.name] = stateConfig.initial ? stateConfig.value : null;
        } else if (stateConfig.type === "rpcMethodTrigger") {
            currentState[stateConfig.name] = stateConfig.initial;
        }
    });

    filteredEntries.forEach((entry) => {
        const request = entry.request;
        const response = entry.response;

        const url = request.url;
        const fetchMethod = request.method.toLowerCase();
        const fetchPath = extractFetchPath(url, entryRequestUrl) || "_root";

        // Тело запроса
        const requestText = request.postData?.text;
        const requestBody = parseJson(requestText) ?? {};

        // Тело ответа
        const responseText = response.content?.text;
        const responseBody = parseJson(responseText) ?? {};
        const typeResponse = detectTypeResponse(responseBody);

        // JSON-RPC method из тела запроса (для группировки rpcMethod)
        const requestRpcMethod = requestBody?.method ?? null;

        // Ключ счётчика учитывает rpcMethod при включённой группировке
        const keyParts = [fetchPath, fetchMethod];
        if (rpcMethod && requestRpcMethod) {
            keyParts.push(requestRpcMethod);
        }
        const key = keyParts.join("/");
        if (!(key in indexCounters)) {
            indexCounters[key] = 0;
        }
        indexCounters[key] += 1;
        const currentIndex = indexCounters[key];

        order += 1;

        // Директория для данной комбинации
        const dirParts = [mocksRoot, fetchPath, fetchMethod];
        if (rpcMethod && requestRpcMethod) {
            dirParts.push(requestRpcMethod);
        }
        const entryDir = path.join(...dirParts);

        // Запись файла запроса
        const requestFile = path.join(entryDir, `request-${currentIndex}.json`);
        writeJsonFile(requestFile, requestBody);

        // Запись файла ответа
        const responseFile = path.join(entryDir, `response-${typeResponse}-${currentIndex}.json`);
        writeJsonFile(responseFile, responseBody);

        const orderEntry = {
            order,
            fetchMethod,
            fetchPath,
            typeResponse,
            currentIndex,
        };

        if (rpcMethod) {
            orderEntry.rpcMethod = requestRpcMethod;
        }

        // Обработка состояний: path — чтение из ответа, rpcMethodTrigger — переключение по методу.
        // state — сквозное: каждая запись получает полное текущее состояние.
        // Для path: set_<name> переносится на предыдущую запись (ответ текущего
        // запроса переводит приложение в новое состояние).
        // Для rpcMethodTrigger: set_<name> устанавливается на самой триггер-записи.
        if (states.length > 0) {
            orderEntry.state = {};
        }

        states.forEach((stateConfig) => {
            if (stateConfig.type === "path") {
                const stateValue = getValueByPath(responseBody, stateConfig.path) ?? null;

                // Для null-значения: обновляем только если rpcMethod входит в nullCheckMethods
                let shouldUpdate = true;
                if (stateValue === null && stateConfig.nullCheckMethods) {
                    if (!requestRpcMethod || !stateConfig.nullCheckMethods.includes(requestRpcMethod)) {
                        shouldUpdate = false;
                    }
                }

                if (shouldUpdate && stateValue !== currentState[stateConfig.name]) {
                    // Перенос set_<name> на предыдущую запись
                    if (callingOrder.length > 0) {
                        const prevEntry = callingOrder[callingOrder.length - 1];
                        prevEntry.state[`set_${stateConfig.name}`] = stateValue;
                    }
                    currentState[stateConfig.name] = stateValue;
                }

                // Сквозное state (после возможного обновления)
                orderEntry.state[stateConfig.name] = currentState[stateConfig.name];
            }

            if (stateConfig.type === "rpcMethodTrigger") {
                // Сквозное state (до обновления)
                orderEntry.state[stateConfig.name] = currentState[stateConfig.name];

                if (requestRpcMethod === stateConfig.rpcMethod) {
                    currentState[stateConfig.name] = stateConfig.value;
                    // set_<name> устанавливается на самой триггер-записи
                    orderEntry.state[`set_${stateConfig.name}`] = stateConfig.value;
                }
            }
        });

        callingOrder.push(orderEntry);
    });

    // Запись файла порядка вызовов
    const callingOrderFile = path.join(mocksRoot, "calling-order.json");
    writeJsonFile(callingOrderFile, callingOrder);

    process.stdout.write(`Готово. Обработано запросов: ${filteredEntries.length}\n`);
    process.stdout.write(`Моки сохранены в: ${mocksRoot}\n`);
};

main().catch((error) => {
    process.stderr.write(`Ошибка: ${error.message}\n`);
    process.exit(1);
});