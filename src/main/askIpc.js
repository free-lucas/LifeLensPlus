'use strict';

// Phase 12：问答的 IPC 通道。
// 与其它页面相同的约定：Renderer 只走 IPC，检索 / 组装 Context / 调 Ollama 都在 Main。
// 服务由 getAsk 延迟取：记忆检索装配失败（Embedding / LanceDB 未就绪）时它是 null，
// 这里直接给出可读的错误，而不是让 Renderer 拿到一个 undefined。
const ASK_CHANNEL = 'lifelens:ask';

function registerAskIpc({ ipcMain, getAsk }) {
  ipcMain.handle(ASK_CHANNEL, async (_event, payload) => {
    const ask = getAsk?.() ?? null;
    if (!ask) {
      throw new Error('问答不可用：本地记忆检索没有启动（Embedding 或 LanceDB 未就绪）');
    }
    const question = typeof payload === 'string' ? payload : payload?.question;
    return ask.ask(question);
  });
}

module.exports = { registerAskIpc, ASK_CHANNEL };
