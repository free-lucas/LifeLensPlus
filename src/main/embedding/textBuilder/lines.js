'use strict';

// 三个 Text Builder 共用的小工具：把字段拼成「标签：内容」的行。
// 空值（null / 空串 / 全空白）直接丢掉，不产生空行——不存在的字段不应该出现在 embedding 文本里。

// 标签行：没有内容时返回 null，由调用方过滤。
function labeled(label, value) {
  const text = String(value ?? '').trim();
  return text === '' ? null : `${label}：${text}`;
}

// 数组字段（关键词 / 软件 / 待办）拼成一行文本：非字符串、空串一律跳过。
function listText(values, separator = '、') {
  if (!Array.isArray(values)) return '';
  return values
    .map((item) => String(item ?? '').trim())
    .filter((item) => item !== '')
    .join(separator);
}

module.exports = { labeled, listText };
