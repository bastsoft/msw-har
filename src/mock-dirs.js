import path from "node:path";

/**
 * Нормализация поля mockDir конфига к массиву абсолютных путей.
 *
 * mockDir в конфиге может быть строкой или массивом путей.
 * При генерации используется первая папка массива, сервер читает моки из всех.
 *
 * @param {string|string[]} mockDir — значение поля mockDir из конфига
 * @param {string} root — базовая директория для относительных путей и дефолта
 * @returns {string[]} — массив абсолютных путей (минимум один элемент)
 */
export const normalizeMockDirs = (mockDir, root) => {
    const defaultDir = path.resolve(root, "mocks");

    if (Array.isArray(mockDir)) {
        return mockDir.length > 0 ? mockDir.map((dir) => path.resolve(root, dir)) : [defaultDir];
    }

    return [path.resolve(root, mockDir ?? defaultDir)];
};
