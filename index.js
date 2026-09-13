#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

const ROOT = process.cwd();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, "src");
const CONFIG_PATH = path.resolve(ROOT, "msw-har.config.js");

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
 * Загрузка единого конфиг-файла msw-har.config.js (ES-модуль с default export).
 *
 * @returns {Promise<object>}
 */
const loadConfig = async () => {
    if (!fileExists(CONFIG_PATH)) {
        console.error(`Ошибка: конфиг-файл не найден: ${CONFIG_PATH}`);
        process.exit(1);
    }

    // Подавляем MODULE_TYPELESS_PACKAGE_JSON warning: конфиг-файл .js
    // использует ES-синтаксис, но корневой package.json не имеет "type": "module"
    process.removeAllListeners("warning");

    const configUrl = pathToFileURL(CONFIG_PATH).href;
    const module = await import(configUrl);
    return module.default;
};

/**
 * Определение имени типа по имени HAR-файла.
 *
 * Префикс имени (до "_") используется как ключ в секции `type` конфига.
 * Если такого ключа нет — используется `type.default`.
 *
 * @param {string} harName — имя HAR-файла
 * @param {object} typeSection — объект секции `type` из конфига
 * @returns {string|null} — имя типа или null (будет использован default)
 */
const detectTypeName = (harName, typeSection) => {
    const prefix = harName.split("_")[0];

    if (typeSection && typeSection[prefix]) {
        return prefix;
    }

    return null;
};

const config = await loadConfig();
const HAR_DIR = config.harDir || path.resolve(ROOT, "source");
const MOCKS_DIR = config.mockDir || path.resolve(ROOT, "mocks");
const SOURCE_DIR = HAR_DIR;

/**
 * Запуск команды node с наследованием stdio.
 * При ненулевом коде выхода — прерываем пайплайн.
 *
 * @param {string[]} cmd — массив аргументов (без `node`)
 */
const runNode = (cmd) => {
    console.log(`\n$ node ${cmd.join(" ")}\n`);

    const result = spawnSync("node", ["--no-warnings", ...cmd], {
        stdio: "inherit",
        cwd: ROOT,
    });

    if (result.status !== 0) {
        console.error(`\nКоманда завершилась с кодом ${result.status}`);
        process.exit(result.status ?? 1);
    }
};

/**
 * Режим 1: передан путь до .har файла.
 * Разбиваем имя по "_" → префикс → ищем секцию type.<prefix> в конфиге.
 * Если секция не найдена — используется type.default.
 * Последовательно запускаем unhar-rpc, reduplicates, create-handlers-msw
 * и server.
 *
 * @param {string} harArg — аргумент командной строки (путь или имя)
 */
const runFromHar = (harArg) => {
    const harPath = path.resolve(ROOT, harArg);

    if (!fileExists(harPath)) {
        console.error(`Ошибка: HAR-файл не найден: ${harPath}`);
        process.exit(1);
    }

    const harName = path.basename(harPath);
    const typeName = detectTypeName(harName, config.type);
    const mocksName = path.basename(harName, ".har");
    const mocksDir = path.resolve(MOCKS_DIR, mocksName);

    const confArgs = ["-conf", CONFIG_PATH, "-mocks-dir", mocksDir];
    if (typeName) {
        confArgs.push("-type", typeName);
    }

    runNode([path.join(SRC_DIR, "unhar-rpc.js"), harPath, ...confArgs]);
    runNode([path.join(SRC_DIR, "reduplicates.js"), mocksDir, ...confArgs]);
    runNode([path.join(SRC_DIR, "create-handlers-msw.js"), mocksDir, ...confArgs]);
    runNode([path.join(SRC_DIR, "server-all.js"), MOCKS_DIR]);
};

/**
 * Режим -gen: показать HAR-файлы из harDir.
 * После выбора файла — запустить полный пайплайн генерации (как при передаче .har).
 */
const runGen = async () => {
    if (!fs.existsSync(SOURCE_DIR)) {
        console.error(`Ошибка: папка HAR-файлов не найдена: ${SOURCE_DIR}`);
        process.exit(1);
    }

    const harFiles = fs
        .readdirSync(SOURCE_DIR, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".har"))
        .map((entry) => entry.name);

    if (harFiles.length === 0) {
        console.error(`Нет HAR-файлов в ${HAR_DIR}.`);
        process.exit(1);
    }

    console.log("HAR-файлы:\n");
    harFiles.forEach((file, index) => {
        console.log(`  ${index + 1}. ${file}`);
    });

    const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    const answer = await rl.question("\nВыберите номер файла: ");
    rl.close();

    const choice = Number.parseInt(answer, 10);

    if (Number.isNaN(choice) || choice < 1 || choice > harFiles.length) {
        console.error("Ошибка: неверный номер.");
        process.exit(1);
    }

    const selected = harFiles[choice - 1];
    const harPath = path.resolve(SOURCE_DIR, selected);

    runFromHar(harPath);
};

/**
 * Режим 3: аргументов нет.
 * Запускаем единый сервер, который поднимает ВСЕ папки моков из ./mocks
 * одновременно — каждая под своим префиксом (/<folder>/rpc/v1 и т.д.).
 * См. src/server-all.js.
 */
const runAll = () => {
    runNode([path.join(SRC_DIR, "server-all.js"), MOCKS_DIR]);
};

/**
 * Справка по использованию index.js.
 */
const printHelp = () => {
    const usage = [
        "Использование: node index.js [опция] [аргумент]",
        "",
        "Опции:",
        "  -h, --help   показать эту справку и выйти",
        "  -gen         интерактивный выбор HAR-файла из harDir (msw-har.config.js)",
        "               и запуск полного пайплайна генерации",
        "               (unhar-rpc → reduplicates → create-handlers-msw → server-all)",
        "",
        "Аргументы:",
        "  <файл.har>   путь до HAR-файла. Префикс имени (до \"_\") определяет тип",
        "               в секции `type` конфига msw-har.config.js.",
        "               Если тип не найден — используется type.default.",
        "               Запускается полный пайплайн генерации, затем поднимается server-all.",
        "",
        "Без аргументов:",
        "  Запускает единый сервер со ВСЕМИ моками из mockDir одновременно.",
        "  Каждая папка доступна под префиксом /<имя-папки>/, например:",
        "    http://localhost:3002/jrpc_newbie-ea_golden-case/rpc/v1",
        "",
        "Конфигурация:",
        "  Читается из msw-har.config.js (в корне проекта).",
        "  harDir  — папка с HAR-файлами (по умолчанию ./source).",
        "  mockDir — папка для сгенерированных моков (по умолчанию ./mocks).",
        "  type    — секция с конфигами по имени типа.",
        "            type.default используется, если тип не найден по префиксу.",
        "",
        "Примеры:",
        "  node index.js -h",
        "  node index.js -gen",
        "  node index.js source/jrpc_newbie-ea.har",
        "  node index.js",
    ].join("\n");

    console.log(usage);
};

// pnpm может прокидывать `--` как literal аргумент — фильтруем его
const args = process.argv.slice(2).filter((a) => a !== "--");
const arg = args[0];

if (arg === "-h" || arg === "--help") {
    printHelp();
    process.exit(0);
} else if (arg === "-gen") {
    await runGen();
} else if (arg === undefined) {
    runAll();
} else if (arg.endsWith(".har")) {
    runFromHar(arg);
} else {
    printHelp();
    process.exit(1);
}