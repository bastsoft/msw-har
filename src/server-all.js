import express from 'express';
import { createMiddleware } from '@mswjs/http-middleware';
import { pathToFileURL } from 'node:url';
import { readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// mockDir из конфига может быть массивом — index.js прокидывает все папки.
// Моки собираются из всех папок; при совпадении имён приоритет у первой.
const MOCK_DIRS = process.argv.slice(2).length > 0
    ? process.argv.slice(2).map((dir) => resolve(dir))
    : [resolve(process.cwd(), 'mocks')];
const PORT = 3002;

const missingDirs = [];
const existingDirs = [];
MOCK_DIRS.forEach((dir) => {
    if (existsSync(dir)) {
        existingDirs.push(dir);
    } else {
        missingDirs.push(dir);
    }
});

if (existingDirs.length === 0) {
    console.error(`Папки моков не найдены: ${MOCK_DIRS.join(', ')}\nСначала сгенерируйте моки через "node ./msw-har/index.js -gen".`);
    process.exit(1);
}

missingDirs.forEach((dir) => {
    console.warn(`Папка моков не найдена, пропускаем: ${dir}`);
});

// Сканируем каждую существующую папку моков и собираем моки двух видов:
//  1) подпапка с handlers.js — сгенерированный из HAR мок;
//  2) одиночный js-файл в корне mockDir (например mock-data/du-fatality.js) —
//     обрабатывается как обычный handlers.js, имя мока = имя файла без .js.
const mockDirByFolder = {};
const mockPathByFolder = {};
const folders = [];

existingDirs.forEach((dir) => {
    const addMockFolder = (folderName, mockPath, mockDir) => {
        if (mockDirByFolder[folderName]) {
            console.warn(`Мок "${folderName}" из ${mockDir} пропущен: такой мок уже есть в ${mockDirByFolder[folderName]}`);
            return;
        }

        mockDirByFolder[folderName] = mockDir;
        mockPathByFolder[folderName] = mockPath;
        folders.push(folderName);
    };

    readdirSync(dir, { withFileTypes: true })
        .forEach((entry) => {
            // Подпапки-моки: <mockDir>/<folder>/handlers.js
            if (entry.isDirectory()) {
                addMockFolder(entry.name, pathToFileURL(resolve(dir, entry.name, 'handlers.js')).href, dir);
                return;
            }

            // Одиночные js-файлы-моки: <mockDir>/<folder>.js
            if (entry.isFile() && entry.name.endsWith('.js')) {
                addMockFolder(entry.name.replace(/\.js$/, ''), pathToFileURL(resolve(dir, entry.name)).href, dir);
            }
        });
});

if (folders.length === 0) {
    console.error(`Папки моков пусты: ${MOCK_DIRS.join(', ')}\nСначала сгенерируйте моки через "node ./msw-har/index.js -gen".`);
    process.exit(1);
}

/**
 * Форматирование пути MSW-хендлера в строку для вывода.
 *
 * @param {string|RegExp} mswPath — путь из handler.info.path
 * @returns {string}
 */
const formatHandlerPath = (mswPath) => {
    if (mswPath instanceof RegExp) {
        return mswPath.source;
    }
    return mswPath;
};

const app = express();

app.use(express.json());

// Мост между cookie браузера и заголовком x-mock-session (см. server.js).
// Каждый handlers.js хранит сессии в собственной Map, поэтому даже при
// одинаковом sessionId состояния разных моков независимы.
app.use((req, res, next) => {
    const cookie = req.headers.cookie || '';
    const match = cookie.match(/(?:^|;\s*)mock-session=([^;]+)/);
    if (match) {
        req.headers['x-mock-session'] = match[1];
    }

    const writeHead = res.writeHead.bind(res);
    res.writeHead = function (statusCode, statusMessage, headers) {
        const mockSession = res.getHeader('x-mock-session');
        if (mockSession) {
            res.removeHeader('x-mock-session');
            res.setHeader('Set-Cookie', `mock-session=${mockSession}; Path=/; HttpOnly`);
        }
        return writeHead(statusCode, statusMessage, headers);
    };

    next();
});

// Загружаем модуль каждого мока (handlers.js подпапки или одиночный js-файл)
// и монтируем под префиксом /<folder>.
// Express обрезает префикс из req.url перед передачей в middleware,
// поэтому хендлеры вида http.post("/rpc/v1") работают без изменений.
const folderRoutes = {};
const activeFolders = [];

for (const folder of folders) {
    const handlersPath = mockPathByFolder[folder];

    let handlersModule;
    try {
        handlersModule = await import(handlersPath);
    } catch (err) {
        console.warn(`Мок "${folder}" пропущен: не удалось загрузить ${handlersPath}${err.message ? ` (${err.message})` : ''}`);
        continue;
    }

    const { handlers } = handlersModule;

    if (!Array.isArray(handlers)) {
        console.warn(`Мок "${folder}" пропущен: экспорт handlers не является массивом`);
        continue;
    }

    activeFolders.push(folder);

    // Собираем реальные пути из MSW-хендлеров для вывода при старте.
    // Set схлопывает дубликаты маршрутов: переопределяющий хендлер (в начале
    // массива) и переопределяемый имеют одинаковый путь — печатаем один раз.
    folderRoutes[folder] = [...new Set(handlers.map((handler) => {
        const method = handler.info?.method ?? 'ALL';
        const mswPath = handler.info?.path ?? '*';
        return `${method} ${formatHandlerPath(mswPath)}`;
    }))];

    app.use(`/${folder}`, createMiddleware(...handlers));
}

// Health-endpoint: список всех подключённых папок моков
app.get('/__mock-folders', (_req, res) => {
    res.json({ folders: activeFolders });
});

const server = app.listen(PORT, () => {
    console.log(`Mock-сервер запущен на http://localhost:${PORT}`);
    console.log('Доступные моки:\n');
    activeFolders.forEach((folder) => {
        const routes = folderRoutes[folder] ?? [];
        if (routes.length === 0) {
            console.log(`  /${folder}  (хендлеры не найдены)`);
            return;
        }

        routes.forEach((route) => {
            const [method, ...pathParts] = route.split(' ');
            const mswPath = pathParts.join(' ');
            console.log(`  ${method.padEnd(6)} http://localhost:${PORT}/${folder}${mswPath}`);
        });
        console.log('');
    });
});

server.on('error', (err) => {
    console.error(`Не удалось занять порт ${PORT}: ${err.message}`);
    process.exit(1);
});

function shutdown(signal) {
    console.log(`\nПолучен ${signal}, останавливаю сервер...`);
    if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
    }
    server.close(() => {
        console.log('Сервер остановлен.');
        process.exit(0);
    });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));