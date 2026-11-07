'use strict';

// Phase 11：记忆搜索的 IPC 通道。
// 与其它页面相同的约定：Renderer 只走 IPC，检索与回查都在 Main（MemorySearchService）。
// 服务由 getSearch 延迟取：embedding / LanceDB 装配失败时它是 null，这里直接给出可读的错误，
// 而不是让 Renderer 拿到一个 undefined。
const MEMORY_SEARCH_CHANNEL = 'lifelens:memory-search';

function registerSearchIpc({ ipcMain, getSearch }) {
  ipcMain.handle(MEMORY_SEARCH_CHANNEL, async (_event, payload) => {
    const search = getSearch?.() ?? null;
    if (!search) {
      throw new Error('记忆搜索不可用：本地向量索引没有启动（Embedding 或 LanceDB 未就绪）');
    }
    const query = typeof payload === 'string' ? payload : payload?.query;
    const limit = typeof payload === 'string' ? undefined : payload?.limit;
    return search.search(query, { limit });
  });
}

module.exports = { registerSearchIpc, MEMORY_SEARCH_CHANNEL };
