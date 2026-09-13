import express from 'express';
import { createMiddleware } from '@mswjs/http-middleware';
import { pathToFileURL } from 'node:url';
import { readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const MOCKS_DIR = process.argv[2]
    ? resolve(process.cwd(), process.argv[2])
    : resolve(process.cwd(), 'mocks');
const PORT = 3002;

// Сканируем папку моков и собираем все подпапки
if (!existsSync(MOCKS_DIR)) {
    console.error(`Папка моков не найдена: ${MOCKS_DIR}\nСначала сгенерируйте моки через "node ./msw-har/index.js -gen".`);
    process.exit(1);
}

const folders = readdirSync(MOCKS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

if (folders.length === 0) {
    console.error(`Папка моков пуста: ${MOCKS_DIR}\nСначала сгенерируйте моки через "node ./msw-har/index.js -gen".`);
    process.exit(1);
}

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

// Загружаем handlers.js из каждой папки и монтируем под префиксом /<folder>.
// Express обрезает префикс из req.url перед передачей в middleware,
// поэтому хендлеры вида http.post("/rpc/v1") работают без изменений.
for (const folder of folders) {
    const handlersPath = pathToFileURL(resolve(MOCKS_DIR, folder, 'handlers.js')).href;
    const { handlers } = await import(handlersPath);
    app.use(`/${folder}`, createMiddleware(...handlers));
}

// Health-endpoint: список всех подключённых папок моков
app.get('/__mock-folders', (_req, res) => {
    res.json({ folders });
});

const server = app.listen(PORT, () => {
    console.log(`Mock-сервер запущен на http://localhost:${PORT}`);
    console.log('Доступные моки:\n');
    folders.forEach((folder) => {
        console.log(`  http://localhost:${PORT}/${folder}/rpc/v1`);
        console.log(`  http://localhost:${PORT}/${folder}/rpc/test`);
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